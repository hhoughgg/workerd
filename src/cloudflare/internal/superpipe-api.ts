// Copyright (c) 2024 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { WorkerEntrypoint } from "cloudflare-internal:workers"

type PipelineResponse = {
  status: string
}

interface Option {}

// rpc target
declare class BindingInternalEntrypoint extends WorkerEntrypoint {
  send(data: object[], options?: Option[]): Promise<PipelineResponse>
}

// wrapped binding for Cloudflare Pipelines product
// known as SuperPipe internally
export class Pipeline {
  private readonly target: BindingInternalEntrypoint

  public constructor(target: BindingInternalEntrypoint) {
    this.target = target
  }

  public async send(
    data: object[],
    options?: Option[]
  ): Promise<PipelineResponse> {
    return this.target.send(data, options)
  }
}

export default function makeBinding(env: { target: BindingInternalEntrypoint }): Pipeline {
  return new Pipeline(env.target)
}
