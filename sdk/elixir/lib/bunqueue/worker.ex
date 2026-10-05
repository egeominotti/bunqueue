defmodule Bunqueue.Worker do
  @moduledoc """
  Lease-aware worker with bounded batch pulls and automatic job heartbeats.

  The handler may return a result, `{:ok, result}`, `{:error, reason}`, or
  raise. Raising `Bunqueue.UnrecoverableError` skips all remaining retries.
  """

  alias Bunqueue.{Connection, Job, ProtocolError, WorkerLifecycle, WorkerProcessor}

  @enforce_keys [
    :queue,
    :handler,
    :connection,
    :heartbeat_connection,
    :worker_id,
    :stats,
    :lifecycle
  ]
  defstruct [
    :queue,
    :handler,
    :connection,
    :heartbeat_connection,
    :worker_id,
    :stats,
    :lifecycle,
    concurrency: 1,
    batch_size: 1,
    poll_timeout: 1_000,
    lock_ttl: 30_000,
    heartbeat_interval: 10_000,
    stack_trace_limit: 10,
    name: nil
  ]

  @type t :: %__MODULE__{}

  # Wait before the next pull after an empty one, as the main client does
  # (`src/client/worker/runtime/polling.ts`:
  # `pollTimeout > 0 ? 10 : drainDelay`, drainDelay defaulting to 50 ms). A
  # non-blocking poll returns at once and a short long poll returns after it,
  # so without the wait `run/1` re-polls at broker-wait plus round-trip speed.
  @empty_long_poll_delay 10
  @empty_poll_delay 50
  # The BEAM rejects `receive ... after` timeouts above 2^32 - 1 ms.
  @max_timer 4_294_967_295
  # The broker accepts lease TTLs up to Number.MAX_SAFE_INTEGER ms.
  @max_lock_ttl 9_007_199_254_740_991
  @default_lock_ttl 30_000

  @spec new(String.t(), (Job.t() -> term()), keyword()) :: t()
  def new(queue, handler, options \\ []) when is_function(handler, 1) do
    # Validate before any linked process starts, so a rejected option leaks none.
    lock_ttl = options |> Keyword.get(:lock_ttl) |> lock_ttl!()
    concurrency = options |> Keyword.get(:concurrency, 1) |> positive()
    batch_size = options |> Keyword.get(:batch_size, concurrency) |> clamp_batch()
    poll_timeout = options |> Keyword.get(:poll_timeout, 1_000) |> clamp_poll()

    heartbeat_interval =
      options |> Keyword.get(:heartbeat_interval, 10_000) |> heartbeat_interval!()

    connection_options = Keyword.get(options, :connection, options)
    {:ok, connection} = Connection.start_link(connection_options)
    {:ok, heartbeat_connection} = Connection.start_link(connection_options)
    {:ok, lifecycle} = WorkerLifecycle.start_link()
    stats = :atomics.new(3, signed: false)
    worker_id = Keyword.get(options, :worker_id, unique_id())

    %__MODULE__{
      queue: queue,
      handler: handler,
      connection: connection,
      heartbeat_connection: heartbeat_connection,
      worker_id: worker_id,
      stats: stats,
      lifecycle: lifecycle,
      concurrency: concurrency,
      batch_size: batch_size,
      poll_timeout: poll_timeout,
      lock_ttl: lock_ttl,
      heartbeat_interval: heartbeat_interval,
      stack_trace_limit: options |> Keyword.get(:stack_trace_limit, 10) |> positive(),
      name: Keyword.get(options, :name, worker_id)
    }
  end

  @spec run_once(t()) :: {:ok, non_neg_integer()} | {:error, Exception.t()}
  def run_once(worker) do
    case WorkerLifecycle.enter(worker.lifecycle) do
      :ok ->
        try do
          execute_once(worker)
        after
          WorkerLifecycle.leave(worker.lifecycle)
        end

      :stopped ->
        {:ok, 0}
    end
  end

  defp execute_once(worker) do
    with :ok <- register(worker),
         {:ok, response} <- pull_batch(worker) do
      jobs = response["jobs"] || []
      tokens = response["tokens"] || []

      if length(jobs) == length(tokens) do
        results =
          jobs
          |> Enum.zip(tokens)
          |> Task.async_stream(
            fn {raw, token} -> WorkerProcessor.process(worker, raw, token) end,
            max_concurrency: worker.concurrency,
            ordered: false,
            timeout: :infinity
          )
          |> Enum.to_list()

        summarize(results)
      else
        {:error, %ProtocolError{message: "PULLB jobs/tokens length mismatch"}}
      end
    end
  end

  @spec run(t()) :: :ok | {:error, Exception.t()}
  def run(worker) do
    if stopped?(worker) do
      :ok
    else
      case run_once(worker) do
        {:ok, count} ->
          idle_wait(worker, count)
          run(worker)

        {:error, _error} ->
          Process.sleep(100)
          run(worker)
      end
    end
  end

  @spec stop(t()) :: :ok
  def stop(worker) do
    :atomics.put(worker.stats, 3, 1)

    case WorkerLifecycle.begin_stop(worker.lifecycle) do
      :owner ->
        try do
          unregister(worker)
          Connection.close(worker.connection)
          Connection.close(worker.heartbeat_connection)
        after
          WorkerLifecycle.finish_stop(worker.lifecycle)
        end

      :done ->
        :ok
    end

    :ok
  end

  # Best effort: a stopper that takes over from a dead owner may find the
  # connection already closed, and stop must still return.
  defp unregister(worker) do
    if Connection.generation(worker.connection) > 0 do
      Connection.call(
        worker.connection,
        %{"cmd" => "UnregisterWorker", "workerId" => worker.worker_id},
        1_000
      )
    end
  catch
    :exit, _reason -> :ok
  end

  @doc false
  def pull_count(worker), do: min(worker.batch_size, worker.concurrency)

  defp register(worker) do
    command = %{
      "cmd" => "RegisterWorker",
      "workerId" => worker.worker_id,
      "name" => worker.name,
      "queues" => [worker.queue],
      "concurrency" => worker.concurrency,
      "hostname" => hostname(),
      "pid" => os_pid(),
      "startedAt" => System.system_time(:millisecond)
    }

    with {:ok, _response} <- Connection.call(worker.connection, command), do: :ok
  end

  defp pull_batch(worker) do
    command = %{
      "cmd" => "PULLB",
      "queue" => worker.queue,
      "count" => pull_count(worker),
      "timeout" => clamp_poll(worker.poll_timeout),
      "owner" => worker.worker_id,
      "lockTtl" => worker.lock_ttl
    }

    Connection.call(worker.connection, command, worker.poll_timeout + 5_000)
  end

  defp stopped?(worker), do: :atomics.get(worker.stats, 3) == 1

  defp idle_wait(%{poll_timeout: 0}, 0), do: Process.sleep(@empty_poll_delay)
  defp idle_wait(_worker, 0), do: Process.sleep(@empty_long_poll_delay)
  defp idle_wait(_worker, _count), do: :ok

  defp summarize(results) do
    case Enum.find_value(results, fn
           {:ok, {:error, error}} -> error
           {:exit, reason} -> %RuntimeError{message: "worker task exited: #{inspect(reason)}"}
           _result -> nil
         end) do
      nil -> {:ok, Enum.count(results, &match?({:ok, :ok}, &1))}
      error -> {:error, error}
    end
  end

  # Explicit values map exactly as in 0.1.1: any value that is not a positive
  # integer is a batch of 1 (`nil`, a float, a non-number), and the batch is
  # capped at the broker's 1000.
  defp clamp_batch(value), do: value |> positive() |> min(1_000)

  # As in 0.1.1, a number is clamped to 0..30_000 and anything else (`nil`
  # included) is a non-blocking poll; `idle_wait/2` keeps 0 from spinning.
  defp clamp_poll(value) when is_number(value),
    do: value |> trunc() |> max(0) |> min(30_000)

  defp clamp_poll(_value), do: 0

  # As in 0.1.1, a number <= 0, `nil`, `false` or another atom disables
  # heartbeats. A positive number never becomes `after 0` (a JobHeartbeatB
  # loop) or exceeds the BEAM timer limit (a `:timeout_value` crash in the
  # linked heartbeat process). `true` and other non-numbers raise: 0.1.1
  # silently dropped the heartbeats they asked for, so a job outliving its lease
  # was delivered again while still running.
  defp heartbeat_interval!(value) when is_number(value) and value > 0,
    do: value |> trunc() |> max(1) |> min(@max_timer)

  defp heartbeat_interval!(value) when is_number(value), do: nil
  defp heartbeat_interval!(value) when is_atom(value) and value != true, do: nil

  defp heartbeat_interval!(value) do
    raise ArgumentError,
          ":heartbeat_interval must be a number of milliseconds, nil or false, " <>
            "got: #{inspect(value)}"
  end

  # `nil` means the default lease. A positive number becomes whole milliseconds,
  # rounded up so a fraction never reaches 0, and is capped at the broker's
  # limit. Zero, negative and non-number values raise: 0.1.1 turned each of
  # them, and every float, into a 1 ms lease that expired mid-job.
  defp lock_ttl!(nil), do: @default_lock_ttl

  defp lock_ttl!(value) when is_number(value) and value > 0,
    do: value |> ceil() |> min(@max_lock_ttl)

  defp lock_ttl!(value) do
    raise ArgumentError,
          ":lock_ttl must be a positive number of milliseconds, got: #{inspect(value)}"
  end

  defp positive(value) when is_integer(value) and value > 0, do: value
  defp positive(_value), do: 1
  defp hostname, do: :inet.gethostname() |> elem(1) |> to_string()
  defp os_pid, do: :os.getpid() |> to_string() |> String.to_integer()
  defp unique_id, do: "elixir-worker-#{System.unique_integer([:positive, :monotonic])}"
end
