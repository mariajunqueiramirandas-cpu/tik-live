import type { ChannelRow } from "../repos/channels";
import type { UserRow } from "../repos/users";

/** Hono environment shared by every route module. */
export type AppEnv = {
  Variables: {
    requestId: string;
    user: UserRow;
    /** Set by realtime routes once the stage key or ownership check passes. */
    channel: ChannelRow;
    /** Set by `/ws/bridge`: the paired device and its channel, or null when the token is unknown. */
    bridgeDevice: { id: string; channel: ChannelRow } | null;
  };
};
