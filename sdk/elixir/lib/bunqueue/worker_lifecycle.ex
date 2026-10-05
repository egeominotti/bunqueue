defmodule Bunqueue.WorkerLifecycle do
  @moduledoc false

  # The worker stop barrier. `enter/1` admits a run and `leave/1` releases it;
  # `begin_stop/1` returns `:owner` to the first stopper once no admitted run is
  # left, and `:done` to every other stopper after the owner's `finish_stop/1`.
  #
  # Liveness bounds the wait. Every admitted process is monitored, so a run
  # whose process dies without `leave/1` (for example a handler's linked crash
  # killing the run_once caller, which skips its `after`) is released by its
  # `:DOWN`: its handler tasks, heartbeats and ACK/FAIL died with it. A live run
  # is still waited for however long it takes, so the barrier never abandons
  # one. The stop owner is monitored as well: if it dies before
  # `finish_stop/1`, a waiting stopper takes over, or the next one does.

  use GenServer

  def start_link, do: GenServer.start_link(__MODULE__, :ok)
  def enter(server), do: safe_call(server, :enter, :stopped)
  def leave(server), do: GenServer.cast(server, {:leave, self()})
  def begin_stop(server), do: safe_call(server, :begin_stop, :done, :infinity)

  def finish_stop(server) do
    monitor = Process.monitor(server)
    result = safe_call(server, :finish_stop, :ok)

    receive do
      {:DOWN, ^monitor, :process, ^server, _reason} -> result
    end
  end

  @impl true
  def init(:ok) do
    # entrants: pid => {monitor, admitted runs}; owner: nil or a watched stopper.
    {:ok, %{phase: :running, entrants: %{}, owner: nil, followers: []}}
  end

  @impl true
  def handle_call(:enter, {pid, _tag}, %{phase: :running} = state) do
    entrant =
      case Map.fetch(state.entrants, pid) do
        {:ok, {monitor, runs}} -> {monitor, runs + 1}
        :error -> {Process.monitor(pid), 1}
      end

    {:reply, :ok, %{state | entrants: Map.put(state.entrants, pid, entrant)}}
  end

  def handle_call(:enter, _from, state), do: {:reply, :stopped, state}

  def handle_call(:begin_stop, from, %{phase: :running} = state) do
    {:noreply, release(%{state | phase: :stopping, owner: watch(from)})}
  end

  def handle_call(:begin_stop, from, %{phase: :stopping, owner: nil} = state) do
    {:noreply, release(%{state | owner: watch(from)})}
  end

  def handle_call(:begin_stop, from, %{phase: :stopping} = state) do
    {:noreply, %{state | followers: state.followers ++ [watch(from)]}}
  end

  def handle_call(:finish_stop, _from, state) do
    Enum.each(state.followers, &GenServer.reply(&1.from, :done))
    {:stop, :normal, :ok, %{state | phase: :stopped, owner: nil, followers: []}}
  end

  @impl true
  def handle_cast({:leave, pid}, state) do
    entrants =
      case Map.fetch(state.entrants, pid) do
        {:ok, {monitor, 1}} ->
          Process.demonitor(monitor, [:flush])
          Map.delete(state.entrants, pid)

        {:ok, {monitor, runs}} ->
          Map.put(state.entrants, pid, {monitor, runs - 1})

        :error ->
          state.entrants
      end

    {:noreply, release(%{state | entrants: entrants})}
  end

  @impl true
  def handle_info({:DOWN, monitor, :process, pid, _reason}, state) do
    cond do
      match?({:ok, {^monitor, _runs}}, Map.fetch(state.entrants, pid)) ->
        {:noreply, release(%{state | entrants: Map.delete(state.entrants, pid)})}

      state.owner != nil and state.owner.monitor == monitor ->
        {:noreply, promote(%{state | owner: nil})}

      true ->
        followers = Enum.reject(state.followers, &(&1.monitor == monitor))
        {:noreply, %{state | followers: followers}}
    end
  end

  def handle_info(_message, state), do: {:noreply, state}

  # The owner died before finish_stop: the oldest live stopper takes over.
  defp promote(%{followers: [next | rest]} = state),
    do: release(%{state | owner: next, followers: rest})

  defp promote(state), do: state

  # Hand the barrier to the owner once no admitted run is left.
  defp release(%{phase: :stopping, entrants: entrants, owner: %{released: false} = owner} = state)
       when map_size(entrants) == 0 do
    GenServer.reply(owner.from, :owner)
    %{state | owner: %{owner | released: true}}
  end

  defp release(state), do: state

  defp watch({pid, _tag} = from),
    do: %{from: from, monitor: Process.monitor(pid), released: false}

  defp safe_call(server, message, fallback, timeout \\ 5_000) do
    GenServer.call(server, message, timeout)
  catch
    :exit, _reason -> fallback
  end
end
