// Copyright (c) 2024 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import entrypoints from 'cloudflare-internal:workers';

async function* readLines(
  stream: ReadableStream<string>
): AsyncGenerator<string> {
  let start = 0;
  let end = 0;
  let partial = '';

  // @ts-expect-error must have a '[Symbol.asyncIterator]()' method
  // eslint-disable-next-line @typescript-eslint/await-thenable
  for await (const chunk of stream) {
    const full = partial + (chunk as string);
    for (const char of full) {
      if (char === '\n') {
        yield full.substring(start, end);
        end++;
        start = end;
      } else {
        end++;
      }
    }

    partial = full.substring(start, end);
    start = 0;
    end = 0;
  }

  if (partial.length > 0) {
    yield partial;
  }
}

type Batch = {
  id: string; // unique identifier for the batch
  shard: string; // assigned shard
  ts: number; // creation timestamp of the batch

  format: Format;
  size: {
    bytes: number;
    rows: number;
  };
  data: unknown;
};

type JsonStream = Batch & {
  format: Format.JSON_STREAM;
  data: ReadableStream<Uint8Array>;
};

enum Format {
  JSON_STREAM = 'json_stream', // jsonl
}

type PipelineMetadata = {
  id: string;
  name: string;
  ingestionTimestamp: number;
};

export class PipelineTransformImpl extends entrypoints.WorkerEntrypoint {
  #batch?: Batch;
  #initalized: boolean = false;

  // stub overridden on the subclass
  // eslint-disable-next-line @typescript-eslint/require-await
  public async run(
    _records: object[],
    _metadata: PipelineMetadata
  ): Promise<object[]> {
    throw new Error('should be implemented by parent');
  }

  // called by the dispatcher to validate that run is properly implemented by the subclass
  // @ts-expect-error thinks ping is never used
  private _ping(): Promise<void> {
    // making sure the function was overridden by an implementing subclass
    if (this.run !== PipelineTransformImpl.prototype.run) {
      return Promise.resolve();
    } else {
      return Promise.reject(
        new Error(
          'the run method must be overridden by the PipelineTransformationEntrypoint subclass'
        )
      );
    }
  }

  // called by the dispatcher which then calls the subclass methods
  // the reason this is typescript private and not javascript private is that this must be
  // able to be called by the dispatcher but should not be called by the class implementer
  // @ts-expect-error _transform is called by rpc
  private async _run(
    batch: Batch,
    metadata: PipelineMetadata
  ): Promise<JsonStream> {
    if (this.#initalized) {
      throw new Error('pipeline entrypoint has already been initialized');
    }

    this.#batch = batch;
    this.#initalized = true;

    if (this.#batch.format === Format.JSON_STREAM) {
      const data = await this.#readJsonStream();
      const transformed = await this.run(data, metadata);
      return this.#sendJson(transformed);
    } else {
      throw new Error(
        'PipelineTransformationEntrypoint run supports only the JSON_STREAM batch format'
      );
    }
  }

  async #readJsonStream(): Promise<object[]> {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.#batch!.format !== Format.JSON_STREAM) {
      throw new Error(`expected JSON_STREAM not ${this.#batch!.format}`);
    }

    const batch = this.#batch!.data as ReadableStream<Uint8Array>;
    const decoder = batch.pipeThrough(new TextDecoderStream());

    const data: object[] = [];
    for await (const line of readLines(decoder)) {
      data.push(JSON.parse(line) as object);
    }

    return data;
  }

  #sendJson(data: object[]): JsonStream {
    if (!(data instanceof Array)) {
      throw new Error('transformJson must return an array of objects');
    }

    let written = 0;
    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const obj of data) {
          const encoded = encoder.encode(`${JSON.stringify(obj)}\n`);
          written += encoded.length;
          controller.enqueue(encoded);
        }

        controller.close();
      },
    });

    return {
      id: this.#batch!.id,
      shard: this.#batch!.shard,
      ts: this.#batch!.ts,
      format: Format.JSON_STREAM,
      size: {
        bytes: written,
        rows: data.length,
      },
      data: readable,
    };
  }
}
