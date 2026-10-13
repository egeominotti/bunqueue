defmodule Bunqueue.TestBrokerTest do
  @moduledoc """
  The test broker is an OS process (`bun src/main.ts`). Closing its Erlang port
  does not stop it, so the broker must be terminated on every exit path of the
  process that started it, not only when `stop/1` is called.

  ExUnit ends a test process with `exit(:shutdown)` and only then runs its
  `on_exit/1` callbacks; a timed-out test is killed; a `setup_all` process exits
  normally. When the linked owner died with the test process, a later `stop/1`
  found nothing to stop and the broker outlived the suite: six orphaned brokers
  per `mix test` run, accumulating in the sandbox container and on developer
  machines.
  """
  use ExUnit.Case

  alias Bunqueue.TestBroker

  @bound 5_000

  for reason <- [:shutdown, :normal, :kill] do
    @tag exit_reason: reason
    test "a broker started by a process that exits with #{inspect(reason)} does not outlive it",
         %{exit_reason: reason} do
      parent = self()

      starter =
        spawn(fn ->
          send(parent, {:broker, TestBroker.start!()})

          receive do
            {:exit, reason} -> exit(reason)
          end
        end)

      assert_receive {:broker, broker}, 20_000
      os_pid = broker_os_pid(broker)
      monitor = Process.monitor(starter)
      expected = end_starter(starter, reason)
      assert_receive {:DOWN, ^monitor, :process, ^starter, ^expected}, @bound

      # What `on_exit(fn -> TestBroker.stop(broker) end)` does after the test process is gone.
      assert TestBroker.stop(broker) == :ok

      gone = eventually(fn -> refused?(broker.port) and not os_alive?(os_pid) end)
      unless gone, do: os_signal(os_pid, "KILL")
      assert gone, "broker #{os_pid} still runs on port #{broker.port} after its starter exited"
    end
  end

  # ExUnit kills a timed-out test; every other exit reason is the process's own.
  defp end_starter(starter, :kill) do
    Process.exit(starter, :kill)
    :killed
  end

  defp end_starter(starter, reason) do
    send(starter, {:exit, reason})
    reason
  end

  defp broker_os_pid(%{owner: owner}) do
    Enum.find_value(Port.list(), fn port ->
      with {:connected, ^owner} <- Port.info(port, :connected),
           {:os_pid, os_pid} <- Port.info(port, :os_pid) do
        os_pid
      else
        _ -> nil
      end
    end) || flunk("the broker owner holds no OS process port")
  end

  defp refused?(port) do
    case :gen_tcp.connect(~c"127.0.0.1", port, [:binary, active: false], 200) do
      {:ok, socket} ->
        :gen_tcp.close(socket)
        false

      {:error, _reason} ->
        true
    end
  end

  # `kill` is a shell builtin; slim images ship no standalone binary.
  defp os_alive?(os_pid), do: os_signal(os_pid, "0") == 0

  defp os_signal(os_pid, signal) do
    {_output, status} =
      System.cmd("sh", ["-c", "kill -#{signal} #{os_pid}"], stderr_to_stdout: true)

    status
  end

  defp eventually(check, deadline \\ System.monotonic_time(:millisecond) + @bound) do
    cond do
      check.() ->
        true

      System.monotonic_time(:millisecond) > deadline ->
        false

      true ->
        Process.sleep(50)
        eventually(check, deadline)
    end
  end
end
