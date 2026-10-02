// bunqueue Academy, the free video course on YouTube. The homepage section and the
// /academy/ docs page both render from this list, so an episode is published in one place.
// An episode without a videoId is announced as "coming soon" and never embedded. To publish
// one, add its videoId, duration and (when it is not ACADEMY_UPLOAD_DATE) uploadDate, plus
// its thumbnail as public/academy/NN.jpg (960x540).

export const ACADEMY_PLAYLIST_ID = 'PLAwZF6aEnSiM';
export const ACADEMY_PLAYLIST_URL = `https://www.youtube.com/playlist?list=${ACADEMY_PLAYLIST_ID}`;
export const ACADEMY_CHANNEL_URL = 'https://www.youtube.com/@bunqueue';
/** Default publication date for VideoObject structured data; an episode can override it. */
export const ACADEMY_UPLOAD_DATE = '2026-10-02';

export interface AcademyEpisode {
  /** Episode number; 0 is the 60-second overview that opens the series. */
  readonly number: number;
  readonly title: string;
  /** Short line under the title, matching the episode thumbnail. */
  readonly topic: string;
  readonly summary: string;
  /** Docs page the episode follows. */
  readonly guide: string;
  /** YouTube video ID. Absent until the episode is public. */
  readonly videoId?: string;
  /** Running time as shown on YouTube, for example "19:14". */
  readonly duration?: string;
  /** YouTube publication date (YYYY-MM-DD) when it differs from ACADEMY_UPLOAD_DATE. */
  readonly uploadDate?: string;
}

export const academyEpisodes: readonly AcademyEpisode[] = [
  {
    number: 0,
    title: 'Introducing bunqueue',
    topic: 'The job queue built for Bun',
    summary:
      'A 60-second overview: embedded mode, persistence without Redis, retries and the dead letter queue, workflows, the dashboard and the SDKs.',
    guide: '/guide/introduction/',
    videoId: 'fWrZLzElXtA',
    duration: '1:01',
  },
  {
    number: 1,
    title: 'Quickstart',
    topic: 'Your first job queue',
    summary:
      'Build your first background job queue, embedded in your app and as a standalone server, persisted to one SQLite file.',
    guide: '/guide/quickstart/',
    videoId: '7ZyJq-ilGv0',
    duration: '19:14',
  },
  {
    number: 2,
    title: 'Queue',
    topic: 'Add, dedupe, control',
    summary:
      'The producer side: job options, priorities and delays, deduplication, querying, pause and drain, rate limits and concurrency caps.',
    guide: '/guide/queue/',
    videoId: 'zB16HOrnAUY',
    duration: '25:37',
  },
  {
    number: 3,
    title: 'Worker',
    topic: 'Leases, heartbeats, retries',
    summary:
      'Consuming jobs: concurrency and batching, events, errors and retries, leases and heartbeats, stall detection and a clean shutdown.',
    guide: '/guide/worker/',
    videoId: 'VIdCsEMurNY',
    duration: '24:46',
  },
  {
    number: 4,
    title: 'Cron & Scheduler',
    topic: 'Schedules that survive restarts',
    summary:
      'Cron patterns, fixed-rate intervals, time zones and delayed jobs, persisted so your schedules survive a restart.',
    guide: '/guide/cron/',
    videoId: 'bC1bxvOcr_I',
    duration: '19:44',
  },
  {
    number: 5,
    title: 'Dead Letter Queue',
    topic: 'Retries, stalls, the DLQ',
    summary:
      'What happens when jobs fail: attempts and backoff, timeouts, stalled workers, and the dead letter queue to inspect, retry and purge failures.',
    guide: '/guide/dlq/',
    videoId: 'Z7C5fv3nk_w',
    duration: '21:12',
  },
  {
    number: 6,
    title: 'FlowProducer',
    topic: 'Parents wait for children',
    summary:
      'Parent and child job graphs, created atomically, with each parent released once its children complete.',
    guide: '/guide/flow/',
    videoId: 'kUaBOsXzQ-o',
    duration: '18:56',
  },
  {
    number: 7,
    title: 'Workflow Engine',
    topic: 'Sagas, approvals, recovery',
    summary:
      'Durable multi-step workflows with typed steps, retries, human approval, saga rollback and crash recovery.',
    guide: '/guide/workflow/',
  },
  {
    number: 8,
    title: 'SDKs, CLI & MCP',
    topic: 'Six languages, one broker',
    summary: 'One wire protocol behind six SDKs, a command line, an MCP server and an HTTP API.',
    guide: '/guide/sdks/',
  },
  {
    number: 9,
    title: 'Production',
    topic: 'Deploy, secure, observe',
    summary: 'Deploy, configure, secure, observe and back up a bunqueue server.',
    guide: '/guide/production/',
  },
  {
    number: 10,
    title: 'Framework Integrations',
    topic: 'Any stack, one queue',
    summary: 'Hono, Elysia, Node.js, edge gateways and AI agents.',
    guide: '/guide/integrations/',
  },
];

export const releasedEpisodes = academyEpisodes.filter((episode) => episode.videoId);
export const upcomingEpisodes = academyEpisodes.filter((episode) => !episode.videoId);

/** Two-digit label used in headings, anchors and thumbnails: 0 becomes "00". */
export const episodeLabel = (episode: AcademyEpisode): string =>
  String(episode.number).padStart(2, '0');

export const episodeAnchor = (episode: AcademyEpisode): string =>
  `episode-${episodeLabel(episode)}`;

export const episodeThumbnail = (episode: AcademyEpisode): string =>
  `/academy/${episodeLabel(episode)}.jpg`;

export const episodeWatchUrl = (episode: AcademyEpisode): string =>
  `https://www.youtube.com/watch?v=${episode.videoId}&list=${ACADEMY_PLAYLIST_ID}`;

/** Converts "m:ss" or "h:mm:ss" to seconds. */
export function durationSeconds(duration: string): number {
  return duration.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

/** ISO 8601 duration for structured data, for example "PT19M14S". */
export function isoDuration(duration: string): string {
  const seconds = durationSeconds(duration);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s}S`;
}

/** Total running time of the released episodes, for example "2 h 10 min". */
export function totalRuntime(): string {
  const minutes = Math.round(
    releasedEpisodes.reduce(
      (total, episode) => total + durationSeconds(episode.duration ?? '0'),
      0
    ) / 60
  );
  const h = Math.floor(minutes / 60);
  return h ? `${h} h ${minutes % 60} min` : `${minutes} min`;
}
