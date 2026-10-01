defmodule Bunqueue.Options do
  @moduledoc false

  @job_keys %{
    "priority" => "priority",
    "delay" => "delay",
    "attempts" => "maxAttempts",
    "maxAttempts" => "maxAttempts",
    "backoff" => "backoff",
    "ttl" => "ttl",
    "timeout" => "timeout",
    "jobId" => "jobId",
    "uniqueKey" => "uniqueKey",
    "dedup" => "dedup",
    "dependsOn" => "dependsOn",
    "parentId" => "parentId",
    "childrenIds" => "childrenIds",
    "tags" => "tags",
    "groupId" => "groupId",
    "lifo" => "lifo",
    "removeOnComplete" => "removeOnComplete",
    "removeOnFail" => "removeOnFail",
    "stallTimeout" => "stallTimeout",
    "durable" => "durable",
    "repeat" => "repeat",
    "debounceId" => "debounceId",
    "debounceTtl" => "debounceTtl",
    "stackTraceLimit" => "stackTraceLimit",
    "keepLogs" => "keepLogs",
    "sizeLimit" => "sizeLimit",
    "timestamp" => "timestamp",
    "failParentOnFailure" => "failParentOnFailure",
    "removeDependencyOnFailure" => "removeDependencyOnFailure",
    "ignoreDependencyOnFailure" => "ignoreDependencyOnFailure",
    "continueParentOnFailure" => "continueParentOnFailure"
  }

  @cron_keys %{
    "pattern" => "schedule",
    "schedule" => "schedule",
    "every" => "repeatEvery",
    "repeatEvery" => "repeatEvery",
    "limit" => "maxLimit",
    "maxLimit" => "maxLimit",
    "tz" => "timezone",
    "timezone" => "timezone",
    "immediately" => "immediately",
    "uniqueKey" => "uniqueKey",
    "dedup" => "dedup",
    "skipIfNoWorker" => "skipIfNoWorker",
    "skipMissedOnRestart" => "skipMissedOnRestart",
    "preventOverlap" => "preventOverlap",
    "priority" => "priority"
  }

  @cron_job_keys ~w(maxAttempts backoff timeout delay stallTimeout removeOnComplete removeOnFail)

  @dedup_policy ~w(ttl extend replace)

  @spec job(keyword() | map(), boolean()) :: map()
  def job(options, bulk \\ false) do
    {output, deduplication} =
      options
      |> enumerable()
      |> Enum.reduce({%{}, nil}, fn {raw_key, value}, {output, deduplication} ->
        case to_string(raw_key) do
          "deduplication" -> {output, value}
          key -> {Map.put(output, job_key!(key, bulk), value), deduplication}
        end
      end)

    put_deduplication(output, deduplication)
  end

  @spec scheduler(keyword() | map()) :: map()
  def scheduler(options) do
    options
    |> enumerable()
    |> Enum.reduce(%{}, fn {raw_key, value}, output ->
      key = to_string(raw_key)
      wire_key = Map.get(@cron_keys, key) || raise ArgumentError, "unknown repeat option: #{key}"
      Map.put(output, wire_key, value)
    end)
  end

  @spec scheduler_job(keyword() | map()) :: map()
  def scheduler_job(options) do
    if deduplication_option?(options) do
      raise ArgumentError, "option deduplication is not supported in scheduler jobOptions"
    end

    mapped = job(options)

    Enum.reduce(mapped, %{}, fn {key, value}, output ->
      if key in @cron_job_keys do
        Map.put(output, key, value)
      else
        raise ArgumentError, "option #{key} is not supported in scheduler jobOptions"
      end
    end)
  end

  defp deduplication_option?(options) do
    Enum.any?(enumerable(options), fn {key, _value} -> to_string(key) == "deduplication" end)
  end

  defp job_key!(key, bulk) do
    wire_key = Map.get(@job_keys, key) || raise ArgumentError, "unknown job option: #{key}"
    if bulk and wire_key == "jobId", do: "customId", else: wire_key
  end

  # The broker deduplicates only when uniqueKey is set, so deduplication.id
  # becomes uniqueKey and only the ttl/extend/replace policy travels as dedup.
  # Applied after every other option so an explicit uniqueKey wins in any order.
  defp put_deduplication(output, nil), do: output

  defp put_deduplication(output, deduplication) do
    fields = deduplication_fields!(deduplication)

    unless is_nil(output["dedup"]) do
      raise ArgumentError, "use either the deduplication or the dedup job option, not both"
    end

    policy =
      fields
      |> Map.take(@dedup_policy)
      |> Map.reject(fn {_key, value} -> is_nil(value) end)

    # An empty uniqueKey disables deduplication on the broker, so it counts as unset.
    output =
      if output["uniqueKey"] in [nil, ""],
        do: Map.put(output, "uniqueKey", fields["id"]),
        else: output

    if map_size(policy) == 0, do: output, else: Map.put(output, "dedup", policy)
  end

  defp deduplication_fields!(%_{} = struct) do
    raise ArgumentError, "deduplication must be a map or keyword list, got: #{inspect(struct)}"
  end

  defp deduplication_fields!(value) when is_map(value) or is_list(value) do
    case Enum.reduce(value, %{}, &put_deduplication_field!/2) do
      %{"id" => id} = fields when is_binary(id) and id != "" ->
        fields

      _fields ->
        raise ArgumentError,
              "deduplication requires a non-empty string id, got: #{inspect(value)}"
    end
  end

  defp deduplication_fields!(other) do
    raise ArgumentError, "deduplication must be a map or keyword list, got: #{inspect(other)}"
  end

  defp put_deduplication_field!({raw_key, value}, fields)
       when is_atom(raw_key) or is_binary(raw_key) do
    key = to_string(raw_key)

    cond do
      key != "id" and key not in @dedup_policy ->
        raise ArgumentError, "unknown deduplication option: #{key}"

      Map.has_key?(fields, key) ->
        raise ArgumentError, "duplicate deduplication option: #{key}"

      true ->
        Map.put(fields, key, value)
    end
  end

  defp put_deduplication_field!(entry, _fields) do
    raise ArgumentError, "deduplication entries must be key-value pairs, got: #{inspect(entry)}"
  end

  defp enumerable(options) when is_map(options), do: options
  defp enumerable(options) when is_list(options), do: options
  defp enumerable(nil), do: []

  defp enumerable(other),
    do: raise(ArgumentError, "options must be a map or keyword list, got: #{inspect(other)}")
end
