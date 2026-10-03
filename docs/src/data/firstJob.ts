/**
 * The "first job" examples, in one place: the homepage quickstart and the top of
 * /guide/quickstart/ render them through components/FirstJobCode.astro, so a newcomer
 * sees the same tested files wherever they start. test/docs-homepage-snippets.test.ts
 * type-checks the TypeScript ones against the public client APIs.
 */

export interface FirstJobFile {
  name: string;
  lang: string;
  code: string;
}

export interface FirstJobRuntime {
  id: string;
  label: string;
  /** Install the client (or bunqueue itself, embedded). */
  install: string;
  files: FirstJobFile[];
  /** Run the example. */
  run: string;
}

/** What the worker prints for the job every example adds. */
export const FIRST_JOB_OUTPUT = 'Processing: hello@example.com';

/** Start the server with the Bun CLI (needs Bun installed). */
export const BUN_CLI_SERVER = 'bunx bunqueue start --host 127.0.0.1 --data-path ./bunqueue.db';

/** Start the server with Docker; `tag` picks the base image variant. */
export const dockerRunCommand = (tag = 'alpine'): string =>
  [
    'docker run -d --name bunqueue \\',
    '  --restart unless-stopped \\',
    '  -p 127.0.0.1:6789:6789 \\',
    '  -p 127.0.0.1:6790:6790 \\',
    '  -v bunqueue-data:/app/data \\',
    `  egeominotti/bunqueue:${tag}`,
  ].join('\n');

export const SERVER_HEALTH_CHECK = 'curl --fail http://127.0.0.1:6790/health';

/** Clients that connect to a running server, in the order the tabs show them. */
export const SERVER_RUNTIMES: FirstJobRuntime[] = [
  {
    id: 'node',
    label: 'Node.js',
    install: 'npm install bunqueue-client',
    files: [
      {
        name: 'jobs.mjs',
        lang: 'javascript',
        code: "import { Queue, Worker } from 'bunqueue-client';\n\nconst options = {\n  embedded: false,\n  connection: { host: '127.0.0.1', port: 6789 },\n};\nconst queue = new Queue('emails', options);\n\nconst worker = new Worker(\n  'emails',\n  async (job) => {\n    console.log('Processing:', job.data.to);\n    return { sent: true };\n  },\n  options\n);\n\nworker.on('error', (error) => console.error(error));\nawait queue.add('welcome', { to: 'hello@example.com' });",
      },
    ],
    run: 'node jobs.mjs',
  },
  {
    id: 'bun',
    label: 'Bun',
    install: 'bun add bunqueue-client',
    files: [
      {
        name: 'jobs.mjs',
        lang: 'javascript',
        code: "import { Queue, Worker } from 'bunqueue-client';\n\nconst options = {\n  embedded: false,\n  connection: { host: '127.0.0.1', port: 6789 },\n};\nconst queue = new Queue('emails', options);\n\nconst worker = new Worker(\n  'emails',\n  async (job) => {\n    console.log('Processing:', job.data.to);\n    return { sent: true };\n  },\n  options\n);\n\nworker.on('error', (error) => console.error(error));\nawait queue.add('welcome', { to: 'hello@example.com' });",
      },
    ],
    run: 'bun jobs.mjs',
  },
  {
    id: 'deno',
    label: 'Deno',
    install: 'deno add npm:bunqueue-client',
    files: [
      {
        name: 'jobs.ts',
        lang: 'typescript',
        code: "import { Queue, Worker } from 'bunqueue-client';\n\nconst options = {\n  embedded: false,\n  connection: { host: '127.0.0.1', port: 6789 },\n};\nconst queue = new Queue<{ to: string }>('emails', options);\n\nconst worker = new Worker<{ to: string }>(\n  'emails',\n  async (job) => {\n    console.log('Processing:', job.data.to);\n    return { sent: true };\n  },\n  options\n);\n\nworker.on('error', (error) => console.error(error));\nawait queue.add('welcome', { to: 'hello@example.com' });",
      },
    ],
    run: 'deno run --allow-net --allow-env --allow-read --allow-sys jobs.ts',
  },
  {
    id: 'python',
    label: 'Python',
    install: 'pip install bunqueue-client',
    files: [
      {
        name: 'jobs.py',
        lang: 'python',
        code: 'from bunqueue import Queue, Worker\n\nconnection = {"host": "127.0.0.1", "port": 6789}\nqueue = Queue("emails", **connection)\nqueue.add("welcome", {"to": "hello@example.com"})\nqueue.close()\n\ndef process(job):\n    print("Processing:", job.data["to"])\n    return {"sent": True}\n\nWorker("emails", process, **connection).run()',
      },
    ],
    run: 'python jobs.py',
  },
  {
    id: 'php',
    label: 'PHP',
    install: 'composer require bunqueue/client   # PHP 8.1+ and Composer',
    files: [
      {
        name: 'jobs.php',
        lang: 'php',
        code: "<?php\nrequire __DIR__ . '/vendor/autoload.php';\n\nuse Bunqueue\\Job;\nuse Bunqueue\\Queue;\nuse Bunqueue\\Worker;\n\n$connection = ['host' => '127.0.0.1', 'port' => 6789];\n\n$queue = new Queue('emails', $connection);\n$queue->add('welcome', ['to' => 'hello@example.com']);\n$queue->close();\n\n$worker = new Worker('emails', function (Job $job) {\n    echo 'Processing: ', $job->data()['to'], PHP_EOL;\n    return ['sent' => true];\n}, $connection);\n$worker->run();",
      },
    ],
    run: 'php jobs.php',
  },
  {
    id: 'go',
    label: 'Go',
    install: 'go mod init jobs && go get github.com/egeominotti/bunqueue/sdk/go   # Go 1.26.5+',
    files: [
      {
        name: 'main.go',
        lang: 'go',
        code: 'package main\n\nimport (\n\t"fmt"\n\n\tbunqueue "github.com/egeominotti/bunqueue/sdk/go"\n)\n\nfunc main() {\n\tqueue := bunqueue.NewQueue("emails", bunqueue.Options{Host: "127.0.0.1", Port: 6789})\n\tdefer queue.Close()\n\tif _, err := queue.Add("welcome", map[string]any{"to": "hello@example.com"}, nil); err != nil {\n\t\tpanic(err)\n\t}\n\n\tworker := bunqueue.NewWorker("emails", func(job *bunqueue.Job) (any, error) {\n\t\tfmt.Println("Processing:", any(job.Data()).(map[string]any)["to"])\n\t\treturn map[string]any{"sent": true}, nil\n\t}, bunqueue.WorkerOptions{Host: "127.0.0.1", Port: 6789})\n\tworker.Run()\n}',
      },
    ],
    run: 'go run .',
  },
  {
    id: 'rust',
    label: 'Rust',
    install: 'cargo new jobs && cd jobs && cargo add bunqueue-client',
    files: [
      {
        name: 'src/main.rs',
        lang: 'rust',
        code: 'use bunqueue_client::{ConnectionOptions, JobOptions, Queue, Value, Worker, WorkerOptions};\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let connection = ConnectionOptions {\n        host: "127.0.0.1".into(),\n        port: 6789,\n        ..Default::default()\n    };\n\n    let queue = Queue::new("emails", connection.clone());\n    let data = Value::Map(vec![(Value::from("to"), Value::from("hello@example.com"))]);\n    queue.add("welcome", data, JobOptions::default())?;\n\n    let worker = Worker::new(\n        "emails",\n        |job| {\n            println!("Processing: {}", job.data()["to"].as_str().unwrap_or_default());\n            Ok(Value::Map(vec![(Value::from("sent"), Value::from(true))]))\n        },\n        WorkerOptions { connection, ..Default::default() },\n    );\n    worker.run()?;\n    Ok(())\n}',
      },
    ],
    run: 'cargo run',
  },
  {
    id: 'elixir',
    label: 'Elixir',
    install:
      'git clone --depth 1 https://github.com/egeominotti/bunqueue && mix new jobs && cd jobs',
    files: [
      {
        name: 'mix.exs',
        lang: 'elixir',
        code: '# Replace the generated deps/0. Hex release upcoming: until then, use the\n# bunqueue checkout next to this project as a path dependency.\ndefp deps do\n  [{:bunqueue_client, path: "../bunqueue/sdk/elixir"}]\nend',
      },
      {
        name: 'jobs.exs',
        lang: 'elixir',
        code: 'connection = [host: "127.0.0.1", port: 6789]\n\nqueue = Bunqueue.queue("emails", connection)\n{:ok, _job} = Bunqueue.Queue.add(queue, "welcome", %{to: "hello@example.com"})\n\nworker =\n  Bunqueue.Worker.new(\n    "emails",\n    fn job ->\n      IO.puts("Processing: #{job.data["to"]}")\n      {:ok, %{sent: true}}\n    end,\n    connection: connection\n  )\n\nBunqueue.Worker.run(worker)',
      },
    ],
    run: 'mix local.hex --force && mix deps.get && mix run jobs.exs',
  },
];

/** Bun with the queue embedded in the app: no server. */
export const EMBEDDED_RUNTIME: FirstJobRuntime = {
  id: 'embedded',
  label: 'Embedded in Bun',
  install: 'bun add bunqueue',
  files: [
    {
      name: 'jobs.ts',
      lang: 'typescript',
      code: "import { Queue, Worker } from 'bunqueue/client';\n\nconst queue = new Queue<{ to: string }>('emails', { embedded: true });\n\nconst worker = new Worker<{ to: string }>(\n  'emails',\n  async (job) => {\n    console.log('Processing:', job.data.to);\n    return { sent: true };\n  },\n  { embedded: true }\n);\n\nworker.on('error', (error) => console.error(error));\nawait queue.add('welcome', { to: 'hello@example.com' });",
    },
  ],
  run: 'bun jobs.ts',
};

export function firstJobRuntime(id: string): FirstJobRuntime {
  const runtime = id === 'embedded' ? EMBEDDED_RUNTIME : SERVER_RUNTIMES.find((r) => r.id === id);
  if (!runtime) throw new Error(`Unknown first-job runtime: ${id}`);
  return runtime;
}
