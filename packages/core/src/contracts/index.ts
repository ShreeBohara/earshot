import { EventEnvelope } from "./event-envelope";
import { HealthResponse } from "./health";

/**
 * Every contract that crosses a process or language boundary. Each one is exported
 * to `schemas/<Name>.json` and generated into Pydantic for the lab.
 */
export const contracts = { EventEnvelope, HealthResponse } as const;

export type ContractName = keyof typeof contracts;

export { EventEnvelope, HealthResponse };
