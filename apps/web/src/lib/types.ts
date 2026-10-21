import type { InferResponseType } from "hono/client";
import type { api } from "./api";

type Ok<T> = Exclude<T, { error: { code: string } }>;

export type Me = Ok<InferResponseType<typeof api.api.me.$get>>;
export type AppConfig = InferResponseType<typeof api.api.config.$get>;
export type BillingStatus = Ok<InferResponseType<(typeof api.api.billing)["$get"]>>;
export type VoiceCatalog = Ok<InferResponseType<typeof api.api.voices.$get>>;
export type SessionList = Ok<InferResponseType<(typeof api.api.channels)[":id"]["sessions"]["$get"]>>;
export type SessionSummary = SessionList["sessions"][number];
export type SessionDetail = Ok<InferResponseType<(typeof api.api.channels)[":id"]["sessions"][":sid"]["$get"]>>;
export type Audience = Ok<InferResponseType<(typeof api.api.channels)[":id"]["audience"]["$get"]>>;
export type SegmentScore = Ok<InferResponseType<(typeof api.api.channels)[":id"]["segments"]["$get"]>>["segments"][number];
