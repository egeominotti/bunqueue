defmodule Bunqueue.DurationValidationTest do
  @moduledoc """
  Durations that reach a BEAM timer (`receive ... after`, `GenServer.call/3`,
  `:gen_tcp` deadlines) must never turn into a zero-delay loop, an immediate
  spurious timeout, or a `:timeout_value` crash: the BEAM accepts at most
  4_294_967_295 ms.
  """
  use ExUnit.Case

  alias Bunqueue.{Connection, Queue, Worker}

  @unreachable [host: "127.0.0.1", port: 1, timeout: 10]
  @timer_limit 4_294_967_295

  setup_all do
    broker = Bunqueue.TestBroker.start!()
    on_exit(fn -> Bunqueue.TestBroker.stop(broker) end)
    {:ok, options: [host: "127.0.0.1", port: broker.port]}
  end

  describe "worker heartbeat_interval" do
    test "rounds a positive sub-millisecond interval up to 1 ms instead of 0" do
      worker = new_worker(heartbeat_interval: 0.5)
      assert worker.heartbeat_interval == 1
      Worker.stop(worker)
    end

    test "caps an interval above the BEAM timer limit" do
      for value <- [@timer_limit + 1, 5_000_000_000, 1.0e300] do
        worker = new_worker(heartbeat_interval: value)
        assert worker.heartbeat_interval == @timer_limit
        Worker.stop(worker)
      end
    end

    # nil and non-number intervals keep their 0.1.1 meaning; see option_compat_test.exs.
    test "keeps zero and negative intervals disabled" do
      for value <- [0, -1, -0.5] do
        worker = new_worker(heartbeat_interval: value)
        assert worker.heartbeat_interval == nil
        Worker.stop(worker)
      end
    end

    test "a job survives an interval above the BEAM timer limit", %{options: options} do
      name = "elixir-duration-hb-#{System.unique_integer([:positive])}"
      {:ok, connection} = Connection.start_link(options)
      queue = Queue.new(name, connection)
      {:ok, job} = Queue.add(queue, "work", %{}, durable: true)

      worker =
        Worker.new(
          name,
          fn _job ->
            Process.sleep(50)
            %{done: true}
          end,
          connection: options,
          poll_timeout: 1_000,
          heartbeat_interval: 5_000_000_000
        )

      parent = self()
      {pid, monitor} = spawn_monitor(fn -> send(parent, {:run_once, Worker.run_once(worker)}) end)

      try do
        assert_receive {:run_once, {:ok, 1}}, 5_000
        assert_receive {:DOWN, ^monitor, :process, ^pid, :normal}, 1_000
        assert {:ok, "completed"} = Queue.get_state(queue, job.id)
      after
        Process.demonitor(monitor, [:flush])
        Worker.stop(worker)
        Queue.obliterate(queue)
        Connection.close(connection)
      end
    end
  end

  describe "worker lock_ttl" do
    # 0.1.1 turned each of these into a 1 ms lease; see option_compat_test.exs.
    test "rejects zero, negative and non-number leases" do
      for value <- [0, 0.0, -1, -0.5, :forever, "30000"] do
        assert_raise ArgumentError, ~r/:lock_ttl/, fn -> new_worker(lock_ttl: value) end
      end
    end

    test "a float lease is pulled as whole milliseconds", %{options: options} do
      name = "elixir-duration-lease-#{System.unique_integer([:positive])}"
      {:ok, connection} = Connection.start_link(options)
      queue = Queue.new(name, connection)
      {:ok, job} = Queue.add(queue, "work", %{}, durable: true)

      worker =
        Worker.new(name, fn _job -> %{done: true} end,
          connection: options,
          poll_timeout: 1_000,
          heartbeat_interval: 0,
          lock_ttl: 60_000 / 2
        )

      try do
        assert worker.lock_ttl == 30_000
        assert {:ok, 1} = Worker.run_once(worker)
        assert {:ok, "completed"} = Queue.get_state(queue, job.id)
      after
        Worker.stop(worker)
        Queue.obliterate(queue)
        Connection.close(connection)
      end
    end

    test "keeps a valid lock_ttl and the 30 s default" do
      worker = new_worker(lock_ttl: 60_000)
      assert worker.lock_ttl == 60_000
      Worker.stop(worker)

      worker = new_worker([])
      assert worker.lock_ttl == 30_000
      Worker.stop(worker)
    end
  end

  describe "worker poll loop" do
    test "a non-blocking poll waits between empty pulls", %{options: options} do
      parent = self()
      name = "elixir-duration-poll-#{System.unique_integer([:positive])}"

      worker =
        Worker.new(name, fn _job -> :ok end,
          connection: Keyword.put(options, :event_handler, &send(parent, {:event, &1})),
          poll_timeout: 0,
          heartbeat_interval: 0
        )

      assert worker.poll_timeout == 0
      task = Task.async(fn -> Worker.run(worker) end)
      Process.sleep(1_000)
      Worker.stop(worker)
      assert Task.await(task, 5_000) == :ok
      Process.sleep(100)

      pulls = count_pulls(0)
      # A 50 ms idle wait allows about 20 empty pulls per second; without it
      # the loop re-polls at round-trip speed (thousands per second).
      assert pulls in 2..100, "expected a bounded number of PULLB commands, got #{pulls}"
    end

    test "a 1 ms long poll still waits between empty pulls", %{options: options} do
      parent = self()
      name = "elixir-duration-poll-1ms-#{System.unique_integer([:positive])}"

      worker =
        Worker.new(name, fn _job -> :ok end,
          connection: Keyword.put(options, :event_handler, &send(parent, {:event, &1})),
          poll_timeout: 1,
          heartbeat_interval: 0
        )

      task = Task.async(fn -> Worker.run(worker) end)
      Process.sleep(1_000)
      Worker.stop(worker)
      assert Task.await(task, 5_000) == :ok
      Process.sleep(100)

      pulls = count_pulls(0)
      # The main client waits 10 ms after an empty pull whenever its poll timeout
      # is above 0 (polling.ts): about 90 empty pulls per second at 1 ms instead
      # of one per broker wait plus round trip (734 per second in the Rust SDK).
      assert pulls in 2..150, "expected a bounded number of PULLB commands, got #{pulls}"
    end

    # nil and non-number poll timeouts are non-blocking too; see option_compat_test.exs.
    test "negative poll timeouts are non-blocking polls" do
      for value <- [-5, -0.5] do
        worker = new_worker(poll_timeout: value)
        assert worker.poll_timeout == 0
        Worker.stop(worker)
      end
    end
  end

  describe "connection timeout" do
    test "a timeout below 1 ms falls back to the default", %{options: options} do
      for value <- [0, 0.5] do
        {:ok, connection} = Connection.start_link(Keyword.put(options, :timeout, value))

        try do
          assert {:ok, %{"data" => %{"pong" => true}}} =
                   Connection.call(connection, %{"cmd" => "Ping"})
        after
          Connection.close(connection)
        end
      end
    end

    test "an explicit call timeout below 1 ms uses the connection timeout", %{options: options} do
      {:ok, connection} = Connection.start_link(options)

      try do
        assert {:ok, %{"data" => %{"pong" => true}}} =
                 Connection.call(connection, %{"cmd" => "Ping"}, 0)
      after
        Connection.close(connection)
      end
    end

    test "a timeout above the BEAM timer limit is capped", %{options: options} do
      {:ok, connection} = Connection.start_link(Keyword.put(options, :timeout, 5_000_000_000))

      try do
        assert {:ok, %{"data" => %{"pong" => true}}} =
                 Connection.call(connection, %{"cmd" => "Ping"})

        assert {:ok, %{"data" => %{"pong" => true}}} =
                 Connection.call(connection, %{"cmd" => "Ping"}, 1.0e300)
      after
        Connection.close(connection)
      end
    end
  end

  defp new_worker(options) do
    Worker.new(
      "elixir-duration-options",
      fn _job -> :ok end,
      Keyword.merge([connection: @unreachable], options)
    )
  end

  defp count_pulls(count) do
    receive do
      {:event, %{event: "command", command: "PULLB"}} -> count_pulls(count + 1)
      {:event, _other} -> count_pulls(count)
    after
      0 -> count
    end
  end
end
