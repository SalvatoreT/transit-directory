import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";

interface Params {
  id: string;
}

export class Import511Workflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep) {
    const stopMonitoring = await step.do(
      `Import511Workflow started with id: ${event.payload.id}`,
      async () => {
        const response = await fetch(
          `https://api.511.org/transit/StopMonitoring?api_key=${this.env.API_KEY_511}&agency=${event.payload.id}`,
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText} (event: ${JSON.stringify(event)})`,
          );
        }
        return response.text();
      },
    );

    console.log(stopMonitoring);
  }
}
