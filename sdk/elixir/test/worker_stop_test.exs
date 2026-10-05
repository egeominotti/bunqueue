defmodule Bunqueue.WorkerStopTest do
  @moduledoc """
  `Worker.stop/1` is a barrier: it waits for every admitted run and its
  ACK/FAIL. A run whose process dies without leaving (killed by a link exit)
  must not hold that barrier forever, and a live handler must still be waited
  for. Every wait here is bounded so a regression fails instead of hanging.
  """
  use ExUnit.Case

  alias Bunqueue.{Connection, Queue, Worker, WorkerLifecycle}

  @bound 5_000

  setup_all do
    broker = Bunqueue.TestBroker.start!()
    on_exit(fn -> Bunqueue.TestBroker.stop(broker) end)
    {:ok, options: [host: "127.0.0.1", port: broker.port]}
  end

  describe "lifecycle barrier" do
    test "a run whose process dies without leaving does not hold stop" do
      {:ok, lifecycle} = WorkerLifecycle.start_link()
      entrant = spawn_entrant(lifecycle)

      Process.exit(entrant, :kill)
      stopper = Task.async(fn -> WorkerLifecycle.begin_stop(lifecycle) end)

      assert bounded(stopper) == {:ok, :owner}
      assert WorkerLifecycle.finish_stop(lifecycle) == :ok
    end

    test "a live run still holds stop until it leaves" do
      {:ok, lifecycle} = WorkerLifecycle.start_link()
      entrant = spawn_entrant(lifecycle)

      stopper = Task.async(fn -> WorkerLifecycle.begin_stop(lifecycle) end)
      assert Task.yield(stopper, 300) == nil

      send(entrant, :leave)
      assert bounded(stopper) == {:ok, :owner}
      assert WorkerLifecycle.finish_stop(lifecycle) == :ok
    end

    test "a follower takes over when the stop owner dies before finishing" do
      {:ok, lifecycle} = WorkerLifecycle.start_link()
      entrant = spawn_entrant(lifecycle)

      owner = spawn(fn -> WorkerLifecycle.begin_stop(lifecycle) end)
      wait_until(fn -> Map.get(:sys.get_state(lifecycle), :owner) != nil end)
      follower = Task.async(fn -> WorkerLifecycle.begin_stop(lifecycle) end)
      wait_until(fn -> Map.get(:sys.get_state(lifecycle), :followers) != [] end)

      Process.exit(owner, :kill)
      send(entrant, :leave)

      assert bounded(follower) == {:ok, :owner}
      assert WorkerLifecycle.finish_stop(lifecycle) == :ok
    end
  end

  describe "Worker.stop/1" do
    test "returns after a linked crash kills the process running run_once", %{options: options} do
      {queue, connection} = queue_with_job(options, "elixir-stop-crash")

      worker =
        Worker.new(
          queue.name,
          fn _job ->
            # The crash propagates over links: handler task -> run_once caller.
            spawn_link(fn -> exit(:boom) end)
            Process.sleep(1_000)
            :ok
          end,
          connection: options,
          poll_timeout: 1_000,
          heartbeat_interval: 0
        )

      {runner, monitor} = spawn_monitor(fn -> Worker.run_once(worker) end)
      assert_receive {:DOWN, ^monitor, :process, ^runner, :boom}, @bound

      stopper = Task.async(fn -> Worker.stop(worker) end)

      try do
        assert bounded(stopper) == {:ok, :ok}
        refute Process.alive?(worker.lifecycle)
      after
        cleanup(queue, connection)
      end
    end

    test "still waits for a live slow handler and its ACK", %{options: options} do
      {queue, connection} = queue_with_job(options, "elixir-stop-barrier")
      parent = self()

      worker =
        Worker.new(
          queue.name,
          fn _job ->
            send(parent, :handler_started)
            Process.sleep(800)
            %{slow: true}
          end,
          connection: options,
          poll_timeout: 1_000,
          heartbeat_interval: 0
        )

      runner = Task.async(fn -> Worker.run_once(worker) end)
      assert_receive :handler_started, @bound
      stopper = Task.async(fn -> Worker.stop(worker) end)

      try do
        assert Task.yield(stopper, 300) == nil, "stop returned while a handler was running"
        assert bounded(runner) == {:ok, {:ok, 1}}
        assert bounded(stopper) == {:ok, :ok}
        assert {:ok, "completed"} = Queue.get_state(queue, job_id(queue))
      after
        cleanup(queue, connection)
      end
    end
  end

  # An unlinked process admitted by the barrier; it leaves only when told to.
  defp spawn_entrant(lifecycle) do
    parent = self()

    entrant =
      spawn(fn ->
        :ok = WorkerLifecycle.enter(lifecycle)
        send(parent, {:entered, self()})

        receive do
          :leave -> WorkerLifecycle.leave(lifecycle)
        end

        Process.sleep(:infinity)
      end)

    assert_receive {:entered, ^entrant}, @bound
    entrant
  end

  defp queue_with_job(options, prefix) do
    name = "#{prefix}-#{System.unique_integer([:positive])}"
    {:ok, connection} = Connection.start_link(options)
    queue = Queue.new(name, connection)
    {:ok, job} = Queue.add(queue, "work", %{}, durable: true)
    Process.put({:job, name}, job.id)
    {queue, connection}
  end

  defp job_id(queue), do: Process.get({:job, queue.name})

  defp cleanup(queue, connection) do
    Queue.obliterate(queue)
    Connection.close(connection)
  end

  defp bounded(task), do: Task.yield(task, @bound) || Task.shutdown(task, :brutal_kill)

  defp wait_until(check, deadline \\ System.monotonic_time(:millisecond) + @bound) do
    cond do
      check.() ->
        :ok

      System.monotonic_time(:millisecond) > deadline ->
        flunk("condition not reached within #{@bound} ms")

      true ->
        Process.sleep(10)
        wait_until(check, deadline)
    end
  end
end
