import { getPlatformProxy } from "wrangler";

const proxy = await getPlatformProxy();
export const env = proxy.env;

export class WorkflowEntrypoint {
  ctx: any;
  env: any;
  constructor(ctx: any, env: any) {
    this.ctx = ctx;
    this.env = env;
  }
  async run(_event: any, _step: any): Promise<void> {
    console.log("Mock WorkflowEntrypoint.run called");
  }
}
