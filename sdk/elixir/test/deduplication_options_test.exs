defmodule Bunqueue.DeduplicationOptionsTest do
  # Repro: `deduplication:` was forwarded as the wire field "dedup" without a
  # "uniqueKey". The server only deduplicates when uniqueKey is set, so the
  # option was accepted and silently ignored. The TypeScript and Python SDKs
  # send deduplication.id as uniqueKey and the remaining fields as dedup.
  use ExUnit.Case

  alias Bunqueue.{Connection, FlowPlanner, Options, Queue}

  test "deduplication id becomes uniqueKey and the rest becomes dedup" do
    assert Options.job(deduplication: %{id: "notify-123", ttl: 5_000, extend: true}) == %{
             "uniqueKey" => "notify-123",
             "dedup" => %{"ttl" => 5_000, "extend" => true}
           }

    assert Options.job(%{"deduplication" => %{"id" => "k", "replace" => true}}) == %{
             "uniqueKey" => "k",
             "dedup" => %{"replace" => true}
           }
  end

  test "an explicit uniqueKey wins over the deduplication id" do
    assert Options.job(uniqueKey: "explicit", deduplication: %{id: "ignored", ttl: 1_000}) == %{
             "uniqueKey" => "explicit",
             "dedup" => %{"ttl" => 1_000}
           }
  end

  test "an explicit uniqueKey wins in any option order and input shape" do
    assert Options.job(deduplication: %{id: "ignored"}, uniqueKey: "explicit") == %{
             "uniqueKey" => "explicit"
           }

    assert Options.job(%{"deduplication" => [id: "ignored"], "uniqueKey" => "explicit"}) == %{
             "uniqueKey" => "explicit"
           }

    assert Options.job(uniqueKey: nil, deduplication: %{id: "derived"}) == %{
             "uniqueKey" => "derived"
           }

    assert Options.job(uniqueKey: "", deduplication: %{id: "derived"}) == %{
             "uniqueKey" => "derived"
           }
  end

  test "nil policy fields and a nil deduplication are omitted" do
    assert Options.job(deduplication: [id: "only", ttl: nil, extend: nil]) == %{
             "uniqueKey" => "only"
           }

    assert Options.job(deduplication: nil) == %{}
    assert Options.job(dedup: %{"ttl" => 5}) == %{"dedup" => %{"ttl" => 5}}
  end

  test "bulk entries derive the same uniqueKey and dedup" do
    assert Options.job([jobId: "custom", deduplication: %{id: "b", replace: true}], true) == %{
             "customId" => "custom",
             "uniqueKey" => "b",
             "dedup" => %{"replace" => true}
           }
  end

  test "invalid deduplication values are rejected" do
    cases = [
      {[deduplication: %{ttl: 1_000}], ~r/requires a non-empty string id/},
      {[deduplication: %{id: ""}], ~r/requires a non-empty string id/},
      {[deduplication: %{id: 42}], ~r/requires a non-empty string id/},
      {[deduplication: %{id: nil}], ~r/requires a non-empty string id/},
      {[deduplication: "notify-123"], ~r/must be a map or keyword list/},
      {[deduplication: ["notify-123"]], ~r/must be key-value pairs/},
      {[deduplication: %{id: "k", tll: 1}], ~r/unknown deduplication option: tll/},
      {[deduplication: %{:id => "a", "id" => "b"}], ~r/duplicate deduplication option: id/},
      {[deduplication: %{id: "k"}, dedup: %{ttl: 1}], ~r/not both/},
      {[deduplication: URI.parse("http://example.com")], ~r/must be a map or keyword list/}
    ]

    for {options, message} <- cases do
      assert_raise ArgumentError, message, fn -> Options.job(options) end
      assert_raise ArgumentError, message, fn -> Options.job(options, true) end
    end
  end

  test "flows and scheduler templates reject deduplication before I/O" do
    assert_raise ArgumentError, ~r/deduplication is not supported inside an atomic flow/, fn ->
      FlowPlanner.plan_tree(%{
        name: "job",
        queue: "queue",
        options: [deduplication: %{id: "k"}]
      })
    end

    assert_raise ArgumentError, ~r/deduplication is not supported in scheduler jobOptions/, fn ->
      Options.scheduler_job(deduplication: %{id: "k"})
    end
  end

  describe "against a broker" do
    setup do
      broker = Bunqueue.TestBroker.start!()
      on_exit(fn -> Bunqueue.TestBroker.stop(broker) end)
      {:ok, options: [host: "127.0.0.1", port: broker.port]}
    end

    test "a second add with the same deduplication id returns the first job", %{options: options} do
      name = "elixir-dedup-#{System.unique_integer([:positive])}"
      {:ok, connection} = Connection.start_link(options)
      queue = Queue.new(name, connection)

      {:ok, first} =
        Queue.add(queue, "notify", %{user_id: "123"}, deduplication: %{id: "notify-123"})

      {:ok, second} =
        Queue.add(queue, "notify", %{user_id: "123"}, deduplication: %{id: "notify-123"})

      assert second.id == first.id
      Connection.close(connection)
    end

    test "add_bulk entries are deduplicated by the same id", %{options: options} do
      name = "elixir-dedup-bulk-#{System.unique_integer([:positive])}"
      {:ok, connection} = Connection.start_link(options)
      queue = Queue.new(name, connection)

      {:ok, first} = Queue.add(queue, "notify", %{n: 1}, deduplication: %{id: "bulk-key"})

      {:ok, ids} =
        Queue.add_bulk(queue, [
          %{name: "notify", data: %{n: 2}, opts: [deduplication: %{id: "bulk-key"}]}
        ])

      assert ids == [first.id]
      assert {:ok, 1} = Queue.count(queue)
      Connection.close(connection)
    end

    test "the replace policy reaches the broker", %{options: options} do
      name = "elixir-dedup-replace-#{System.unique_integer([:positive])}"
      {:ok, connection} = Connection.start_link(options)
      queue = Queue.new(name, connection)
      policy = [deduplication: %{id: "latest", ttl: 300_000, replace: true}]

      {:ok, first} = Queue.add(queue, "latest-data", %{data: "old"}, policy)
      {:ok, second} = Queue.add(queue, "latest-data", %{data: "new"}, policy)

      assert second.id != first.id
      assert {:ok, 1} = Queue.count(queue)
      assert {:ok, %{data: %{"data" => "new"}}} = Queue.get_job(queue, second.id)

      {:ok, third} =
        Queue.add(queue, "latest-data", %{data: "dup"}, deduplication: %{id: "latest"})

      assert third.id == second.id
      Connection.close(connection)
    end
  end
end
