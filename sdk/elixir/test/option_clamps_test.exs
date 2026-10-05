defmodule Bunqueue.OptionClampsTest do
  @moduledoc """
  sdk/CLAUDE.md rule 4 (protocol sections 6.3 and 9): the heartbeat interval,
  the batch size, the poll timeout and the `wait_for_job` timeout are clamped to
  what the broker accepts. `nil` and non-number values keep their 0.1.1 meaning
  (see option_compat_test.exs): for `wait_for_job` that is a 0 ms hold, while
  an omitted timeout waits up to 30_000 ms.
  """
  use ExUnit.Case

  alias Bunqueue.{Connection, Queue, TimeoutError, Worker}

  @unreachable [host: "127.0.0.1", port: 1, timeout: 10]
  @non_numbers ["10", :ten, [10], %{}, true]

  setup_all do
    broker = Bunqueue.TestBroker.start!()
    on_exit(fn -> Bunqueue.TestBroker.stop(broker) end)
    {:ok, options: [host: "127.0.0.1", port: broker.port]}
  end

  describe "heartbeat_interval" do
    test "a number <= 0 disables heartbeats" do
      for value <- [0, 0.0, -1, -0.5] do
        assert field(:heartbeat_interval, value) == nil, "#{inspect(value)}"
      end
    end

    test "a positive number is kept within the BEAM timer range" do
      for {value, expected} <- [{20, 20}, {1.7, 1}, {0.5, 1}, {5_000_000_000, 4_294_967_295}] do
        assert field(:heartbeat_interval, value) == expected, "#{inspect(value)}"
      end
    end

    test "nil disables heartbeats, as in 0.1.1" do
      assert field(:heartbeat_interval, nil) == nil
    end

    test "true or a non-atom non-number raises ArgumentError naming the option" do
      for value <- ["10", [10], %{}, true] do
        assert_raise ArgumentError, ~r/:heartbeat_interval/, fn ->
          new_worker(heartbeat_interval: value)
        end
      end
    end
  end

  describe "batch_size" do
    test "an integer is clamped to 1..1000 and any other number is 1, as in 0.1.1" do
      cases = [{-5, 1}, {0, 1}, {0.5, 1}, {2.5, 1}, {64, 64}, {5_000, 1_000}, {5_000.0, 1}]

      for {value, expected} <- cases do
        assert field(:batch_size, value) == expected, "#{inspect(value)}"
      end
    end

    test "nil is a batch of 1 and omission follows the concurrency" do
      worker = new_worker(batch_size: nil, concurrency: 8)
      assert worker.batch_size == 1
      Worker.stop(worker)

      worker = new_worker(concurrency: 8)
      assert worker.batch_size == 8
      Worker.stop(worker)
    end
  end

  describe "poll_timeout" do
    test "any number is clamped to 0..30_000 and truncated" do
      cases = [
        {-5, 0},
        {-0.5, 0},
        {0, 0},
        {1.9, 1},
        {250, 250},
        {90_000, 30_000},
        {1.0e300, 30_000}
      ]

      for {value, expected} <- cases do
        assert field(:poll_timeout, value) == expected, "#{inspect(value)}"
      end
    end

    test "nil or a non-number is a non-blocking poll and omission is 1 s, as in 0.1.1" do
      for value <- [nil | @non_numbers] do
        assert field(:poll_timeout, value) == 0, "#{inspect(value)}"
      end

      worker = new_worker([])
      assert worker.poll_timeout == 1_000
      Worker.stop(worker)
    end
  end

  describe "wait_for_job timeout" do
    test "an omitted timeout waits up to the 30 s default", %{options: options} do
      with_queue(options, fn queue ->
        {:ok, job} = Queue.add(queue, "slow", %{}, durable: true)
        worker = start_worker(queue.name, options)

        try do
          # A 0 ms hold would return before the 300 ms job ends.
          assert {:ok, %{"done" => true}} = Queue.wait_for_job(queue, job.id)
        after
          stop_worker(worker)
        end
      end)
    end

    test "a negative number clamps to an immediate hold", %{options: options} do
      with_queue(options, fn queue ->
        {:ok, job} = Queue.add(queue, "waiting", %{}, durable: true)

        for value <- [-1, -0.5] do
          assert {:error, %TimeoutError{timeout: 0}} = Queue.wait_for_job(queue, job.id, value)
        end
      end)
    end

    test "nil or a non-number is an immediate hold, as in 0.1.1", %{options: options} do
      with_queue(options, fn queue ->
        {:ok, job} = Queue.add(queue, "waiting", %{}, durable: true)

        for value <- [nil, :infinity | @non_numbers] do
          assert {:error, %TimeoutError{timeout: 0}} = Queue.wait_for_job(queue, job.id, value),
                 inspect(value)
        end
      end)
    end
  end

  defp field(option, value) do
    worker = new_worker([{option, value}])
    result = Map.fetch!(worker, option)
    Worker.stop(worker)
    result
  end

  defp new_worker(options) do
    Worker.new(
      "elixir-option-clamps",
      fn _job -> :ok end,
      Keyword.merge([connection: @unreachable], options)
    )
  end

  defp with_queue(options, fun) do
    {:ok, connection} = Connection.start_link(options)
    queue = Queue.new("elixir-clamps-#{System.unique_integer([:positive])}", connection)

    try do
      fun.(queue)
    after
      Queue.obliterate(queue)
      Connection.close(connection)
    end
  end

  defp start_worker(name, options) do
    handler = fn _job ->
      Process.sleep(300)
      %{done: true}
    end

    worker =
      Worker.new(name, handler, connection: options, poll_timeout: 100, heartbeat_interval: 0)

    {worker, Task.async(fn -> Worker.run(worker) end)}
  end

  defp stop_worker({worker, task}) do
    Worker.stop(worker)
    Task.await(task, 10_000)
  end
end
