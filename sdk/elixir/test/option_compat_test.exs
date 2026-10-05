defmodule Bunqueue.OptionCompatTest do
  @moduledoc """
  Backward compatibility of the worker, connection and `wait_for_job` options
  with the previous release (0.1.1). A value that started a worker there starts one here with the
  same effective setting. Only results that were themselves broken change: a
  1 ms lease, a 0 ms or over-limit timer, a heartbeat silently dropped although
  the caller asked for one. Those rows state what replaces them.

  Tests tagged `:release_parity` hold for 0.1.1 as well, so this file can be
  replayed against it with `mix test --only release_parity`. No test here needs
  a broker.
  """
  use ExUnit.Case, async: true

  alias Bunqueue.{Connection, Queue, TimeoutError, Wire, Worker}

  @unreachable [host: "127.0.0.1", port: 1, timeout: 10]
  @max_safe 9_007_199_254_740_991

  describe "heartbeat_interval" do
    @tag :release_parity
    test "an omitted interval keeps the 10 s default" do
      assert field([], :heartbeat_interval) == 10_000
    end

    @tag :release_parity
    test "nil, false and other atoms disable heartbeats" do
      for value <- [nil, false, :infinity, :none, :disabled] do
        assert field(:heartbeat_interval, value) == nil, inspect(value)
      end
    end

    @tag :release_parity
    test "numbers keep their meaning" do
      cases = [
        {0, nil},
        {0.0, nil},
        {-1, nil},
        {-0.5, nil},
        {20, 20},
        {1.7, 1},
        {10_000.9, 10_000}
      ]

      for {value, expected} <- cases do
        assert field(:heartbeat_interval, value) == expected, inspect(value)
      end
    end

    # 0.1.1 silently disabled lease renewal that these values asked for, so a
    # job running longer than the lease was re-delivered while still running.
    test "true and non-atom non-numbers raise instead of dropping heartbeats" do
      for value <- [true, "10000", [10_000], %{}, {10_000}] do
        assert_raise ArgumentError, ~r/:heartbeat_interval/, fn ->
          new_worker(heartbeat_interval: value)
        end
      end
    end
  end

  describe "batch_size" do
    @tag :release_parity
    test "every explicit value maps as before" do
      cases = [
        {nil, 1},
        {2.5, 1},
        {5_000.0, 1},
        {0.5, 1},
        {"10", 1},
        {:ten, 1},
        {true, 1},
        {[10], 1},
        {%{}, 1},
        {0, 1},
        {-5, 1},
        {64, 64},
        {5_000, 1_000}
      ]

      for {value, expected} <- cases do
        assert field(:batch_size, value) == expected, inspect(value)
      end
    end

    @tag :release_parity
    test "an omitted batch size follows the concurrency, up to 1000" do
      assert field([concurrency: 8], :batch_size) == 8
      assert field([concurrency: 2_000], :batch_size) == 1_000
    end
  end

  describe "poll_timeout" do
    @tag :release_parity
    test "an omitted poll timeout keeps the 1 s default" do
      assert field([], :poll_timeout) == 1_000
    end

    @tag :release_parity
    test "every explicit value maps as before" do
      cases = [
        {nil, 0},
        {"1000", 0},
        {:ten, 0},
        {true, 0},
        {[10], 0},
        {%{}, 0},
        {-5, 0},
        {-0.5, 0},
        {0, 0},
        {1.9, 1},
        {250, 250},
        {90_000, 30_000},
        {1.0e300, 30_000}
      ]

      for {value, expected} <- cases do
        assert field(:poll_timeout, value) == expected, inspect(value)
      end
    end
  end

  describe "lock_ttl" do
    @tag :release_parity
    test "an omitted or positive integer lease is unchanged" do
      assert field([], :lock_ttl) == 30_000

      for value <- [1, 60_000, @max_safe] do
        assert field(:lock_ttl, value) == value, inspect(value)
      end
    end

    # 0.1.1 turned each of these into a 1 ms lease that expired mid-job.
    test "nil means the 30 s default lease" do
      assert field(:lock_ttl, nil) == 30_000
    end

    test "a positive float becomes whole milliseconds, rounded up" do
      cases = [{30_000.0, 30_000}, {60_000 / 2, 30_000}, {1.2, 2}, {0.5, 1}, {1.0e300, @max_safe}]

      for {value, expected} <- cases do
        assert field(:lock_ttl, value) == expected, inspect(value)
      end
    end

    test "an integer above the broker's limit is capped instead of rejected" do
      assert field(:lock_ttl, @max_safe + 1) == @max_safe
    end

    test "zero, negative and non-number leases still raise" do
      for value <- [0, 0.0, -1, -0.5, :forever, "30000", true] do
        assert_raise ArgumentError, ~r/:lock_ttl/, fn -> new_worker(lock_ttl: value) end
      end
    end
  end

  describe "wait_for_job timeout" do
    # A 0 ms hold is a poll: the broker answers at once, so an unfinished job
    # returns its timeout immediately and a finished one its result.
    @tag :release_parity
    test "nil or a non-number is a 0 ms hold" do
      for value <- [nil, "1000", :infinity, true, [10], %{}] do
        assert wait_timeout_sent(value) == 0, inspect(value)
      end
    end

    @tag :release_parity
    test "a number is clamped to 0..600_000 ms" do
      cases = [{-5, 0}, {-0.5, 0}, {0, 0}, {1.9, 1}, {250, 250}, {700_000, 600_000}]

      for {value, expected} <- cases ++ [{1.0e300, 600_000}] do
        assert wait_timeout_sent(value) == expected, inspect(value)
      end
    end

    test "an omitted timeout waits up to 30 s" do
      assert wait_timeout_sent(:omitted) == 30_000
    end
  end

  describe "explicit Connection.call/3 timeout" do
    # Against a peer that never answers, a 30 s deadline is still waiting where
    # the connection's own 50 ms one would already have timed out.
    @tag :release_parity
    test "a negative or non-number timeout still means the 30 s default" do
      for value <- [-1, -0.5, "100", :infinity, true] do
        peer = silent_peer()
        {:ok, connection} = Connection.start_link(port: peer.port, timeout: 50)
        call = Task.async(fn -> Connection.call(connection, %{"cmd" => "Ping"}, value) end)

        early = Task.yield(call, 500)
        # Closing the peer ends the pending receive, so nothing waits 30 s.
        close_peer(peer)
        late = early || Task.yield(call, 5_000)
        Connection.close(connection)

        assert early == nil, "#{inspect(value)} used the connection timeout: #{inspect(early)}"
        assert {:ok, {:error, _closed}} = late
      end
    end

    @tag :release_parity
    test "nil and false use the connection timeout" do
      for value <- [nil, false] do
        peer = silent_peer()
        {:ok, connection} = Connection.start_link(port: peer.port, timeout: 50)
        result = Connection.call(connection, %{"cmd" => "Ping"}, value)
        close_peer(peer)
        Connection.close(connection)

        assert {:error, %TimeoutError{timeout: 50}} = result, inspect(value)
      end
    end
  end

  defp field(options, option) when is_list(options) do
    worker = new_worker(options)
    result = Map.fetch!(worker, option)
    Worker.stop(worker)
    result
  end

  defp field(option, value), do: field([{option, value}], option)

  defp new_worker(options) do
    Worker.new(
      "elixir-option-compat",
      fn _job -> :ok end,
      Keyword.merge([connection: @unreachable], options)
    )
  end

  # The WaitJob "timeout" that reaches the wire for this argument.
  defp wait_timeout_sent(timeout) do
    peer = recording_peer()
    {:ok, connection} = Connection.start_link(port: peer.port, timeout: 1_000)
    queue = Queue.new("elixir-option-compat", connection)

    result =
      if timeout == :omitted,
        do: Queue.wait_for_job(queue, "job-1"),
        else: Queue.wait_for_job(queue, "job-1", timeout)

    close_peer(peer)
    Connection.close(connection)

    assert {:ok, "done"} = result
    assert_receive {:command, %{"cmd" => "WaitJob", "timeout" => sent}}, 1_000
    sent
  end

  # Answers one command as a completed WaitJob and reports the command it got.
  defp recording_peer do
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, packet: :raw, reuseaddr: true])
    {:ok, port} = :inet.port(listener)
    parent = self()

    owner =
      spawn_link(fn ->
        with {:ok, socket} <- :gen_tcp.accept(listener, 5_000),
             {:ok, <<length::unsigned-big-32>>} <- :gen_tcp.recv(socket, 4, 5_000),
             {:ok, payload} <- :gen_tcp.recv(socket, length, 5_000),
             {:ok, command} <- Wire.decode(payload),
             reply = %{"ok" => true, "completed" => true, "result" => "done"},
             {:ok, frame} <- Wire.encode(Map.put(reply, "reqId", command["reqId"])) do
          send(parent, {:command, command})
          :ok = :gen_tcp.send(socket, frame)

          receive do
            :close -> :gen_tcp.close(socket)
          after
            10_000 -> :gen_tcp.close(socket)
          end
        end
      end)

    %{listener: listener, port: port, owner: owner}
  end

  # Accepts one connection and never answers it until closed.
  defp silent_peer do
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, packet: :raw, reuseaddr: true])
    {:ok, port} = :inet.port(listener)

    owner =
      spawn_link(fn ->
        with {:ok, socket} <- :gen_tcp.accept(listener, 5_000) do
          receive do
            :close -> :gen_tcp.close(socket)
          after
            10_000 -> :gen_tcp.close(socket)
          end
        end
      end)

    %{listener: listener, port: port, owner: owner}
  end

  defp close_peer(%{listener: listener, owner: owner}) do
    send(owner, :close)
    :gen_tcp.close(listener)
  end
end
