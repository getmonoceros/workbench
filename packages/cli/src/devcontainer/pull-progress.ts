import { Writable } from 'node:stream';

/**
 * Readable progress for `docker compose --progress json pull` (#137). Compose
 * reports every layer of every image as one JSON line; this keeps a running
 * total per image and turns it into:
 *
 *   - a status for the spinner, e.g. `pulling mssql/server:2025-latest ·
 *     312 MB of 605 MB · 4 of 9 layers`, on every byte that arrives;
 *   - lines for the apply log and `--verbose`: progress at most every few
 *     seconds per image, and one line when an image is pulled, already
 *     current, or failed.
 *
 * A layer's size is only known once its download starts, so "of 605 MB"
 * counts the layers seen so far and grows towards the real size; the layer
 * count says how much is still to come.
 */

interface Layer {
  current: number;
  total?: number;
  done: boolean;
}

interface Image {
  layers: Map<string, Layer>;
  /** True once any layer downloaded bytes; false means it was current. */
  downloaded: boolean;
  lastLogged: number;
}

interface ComposeEvent {
  id?: string;
  parent_id?: string;
  status?: string;
  text?: string;
  details?: string;
  current?: number;
  total?: number;
  error?: boolean;
  message?: string;
}

export interface PullProgressOptions {
  /** The spinner's status line. */
  onStatus?: (text: string) => void;
  /** One readable line for the log (and the screen in verbose mode). */
  log: (line: string) => void;
  /** An image that failed, with the registry's reason. */
  onError?: (image: string, reason: string) => void;
  /** Milliseconds between two progress lines of one image in the log. */
  logIntervalMs?: number;
  now?: () => number;
}

const IMAGE_PREFIX = 'Image ';

/** `1.2 MB`, `605 MB`, `840 kB`, decimal like docker's own output. */
export function formatBytes(bytes: number): string {
  if (bytes >= 10e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

/** Drops the registry host, which only makes the spinner line longer. */
function shortName(image: string): string {
  const [first, ...rest] = image.split('/');
  return rest.length > 0 && first!.includes('.') ? rest.join('/') : image;
}

function summary(name: string, image: Image): string {
  let current = 0;
  let total = 0;
  let done = 0;
  for (const l of image.layers.values()) {
    current += l.done && l.total !== undefined ? l.total : l.current;
    total += l.total ?? 0;
    if (l.done) done += 1;
  }
  // Before any layer knows its size there are no bytes to report yet.
  const bytes =
    total > 0 ? ` · ${formatBytes(current)} of ${formatBytes(total)}` : '';
  return `${shortName(name)}${bytes} · ${done} of ${image.layers.size} layers`;
}

export function createPullProgress(opts: PullProgressOptions): Writable {
  const images = new Map<string, Image>();
  const interval = opts.logIntervalMs ?? 5000;
  const now = opts.now ?? Date.now;
  let rest = '';

  const imageOf = (name: string): Image => {
    let image = images.get(name);
    if (!image) {
      image = { layers: new Map(), downloaded: false, lastLogged: -Infinity };
      images.set(name, image);
    }
    return image;
  };

  const onLine = (line: string): void => {
    if (line.trim() === '') return;
    let e: ComposeEvent;
    try {
      e = JSON.parse(line) as ComposeEvent;
    } catch {
      opts.log(line); // not compose's JSON: pass it through as it is
      return;
    }
    if (e.error) {
      opts.log(e.message ?? line);
      return;
    }
    if (e.parent_id?.startsWith(IMAGE_PREFIX) && e.id) {
      const name = e.parent_id.slice(IMAGE_PREFIX.length);
      const image = imageOf(name);
      const layer = image.layers.get(e.id) ?? { current: 0, done: false };
      image.layers.set(e.id, layer);
      if (typeof e.total === 'number') layer.total = e.total;
      if (e.text === 'Downloading' && typeof e.current === 'number') {
        layer.current = e.current;
        image.downloaded = true;
      }
      if (e.status === 'Done') layer.done = true;
      const status = summary(name, image);
      opts.onStatus?.(`pulling ${status}`);
      if (image.downloaded && now() - image.lastLogged >= interval) {
        image.lastLogged = now();
        opts.log(`Pulling ${status}`);
      }
      return;
    }
    if (e.id?.startsWith(IMAGE_PREFIX)) {
      const name = e.id.slice(IMAGE_PREFIX.length);
      const image = imageOf(name);
      if (e.status === 'Error') {
        const reason = (e.details ?? e.text ?? 'failed').split('\n')[0]!;
        opts.log(`Could not pull ${name}: ${reason}`);
        opts.onError?.(name, reason);
      } else if (e.status === 'Done') {
        const size = [...image.layers.values()].reduce(
          (sum, l) => sum + (l.total ?? 0),
          0,
        );
        opts.log(
          image.downloaded
            ? `Pulled ${name} (${formatBytes(size)})`
            : image.layers.size > 0
              ? `Pulled ${name} (every layer was already here)`
              : `${name} is already current`,
        );
      } else {
        opts.onStatus?.(`pulling ${shortName(name)}`);
      }
    }
  };

  return new Writable({
    write(chunk: Buffer, _enc, done) {
      const lines = (rest + chunk.toString()).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) onLine(line);
      done();
    },
    final(done) {
      if (rest) onLine(rest);
      done();
    },
  });
}
