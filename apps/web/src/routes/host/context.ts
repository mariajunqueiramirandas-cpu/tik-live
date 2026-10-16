import type { ChannelDto, RuntimeStatus } from "@tik-live/shared";
import { useOutletContext } from "react-router";
import type { StudioStore } from "../../lib/studio";

export interface HostContext {
  channel: ChannelDto;
  store: StudioStore;
  /** Live status from the studio socket when connected, else from the API. */
  status: RuntimeStatus;
}

export const useHost = () => useOutletContext<HostContext>();

export function stageKeyOf(stageUrl: string): string {
  return decodeURIComponent(stageUrl.split("/s/")[1] ?? "");
}
