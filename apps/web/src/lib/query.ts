import type { ChannelCreateInput, ChannelDto, ChannelListItem, ChannelUpdateInput } from "@tik-live/shared";
import { QueryClient, useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api, ApiError, call } from "./api";
import { toast } from "../ui/toast-store";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: true,
      retry: (failures, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 2,
    },
    mutations: { retry: false },
  },
});

export const keys = {
  config: ["config"] as const,
  me: ["me"] as const,
  channels: ["channels"] as const,
  channel: (id: string) => ["channels", id] as const,
  sessions: (id: string) => ["channels", id, "sessions"] as const,
  session: (id: string, sid: string) => ["channels", id, "sessions", sid] as const,
  audience: (id: string) => ["channels", id, "audience"] as const,
  billing: ["billing"] as const,
  voices: ["voices"] as const,
};

// ---- queries ---------------------------------------------------------------

export const queries = {
  config: () => ({ queryKey: keys.config, queryFn: () => call(api.api.config.$get()), staleTime: Infinity }),
  me: () => ({ queryKey: keys.me, queryFn: () => call(api.api.me.$get()) }),
  channels: () => ({
    queryKey: keys.channels,
    queryFn: async () => (await call(api.api.channels.$get())).channels as ChannelListItem[],
    // The list shows live status; keep it fresh while it's on screen.
    refetchInterval: 15_000,
  }),
  channel: (id: string) => ({
    queryKey: keys.channel(id),
    queryFn: async () => (await call(api.api.channels[":id"].$get({ param: { id } }))).channel as ChannelDto,
  }),
  sessions: (id: string) => ({
    queryKey: keys.sessions(id),
    queryFn: async () => (await call(api.api.channels[":id"].sessions.$get({ param: { id } }))).sessions,
  }),
  session: (id: string, sid: string) => ({
    queryKey: keys.session(id, sid),
    queryFn: () => call(api.api.channels[":id"].sessions[":sid"].$get({ param: { id, sid } })),
    staleTime: 60_000,
  }),
  audience: (id: string) => ({
    queryKey: keys.audience(id),
    queryFn: () => call(api.api.channels[":id"].audience.$get({ param: { id } })),
  }),
  billing: () => ({ queryKey: keys.billing, queryFn: () => call(api.api.billing.$get()) }),
  voices: () => ({ queryKey: keys.voices, queryFn: () => call(api.api.voices.$get()), staleTime: 30 * 60_000 }),
};

export const useConfig = () => useQuery(queries.config());
export const useMe = () => useQuery(queries.me());
export const useChannels = () => useQuery(queries.channels());
export const useChannel = (id: string) => useQuery(queries.channel(id));
export const useSessions = (id: string) => useQuery(queries.sessions(id));
export const useSession = (id: string, sid: string) => useQuery({ ...queries.session(id, sid), enabled: Boolean(sid) });
export const useAudience = (id: string) => useQuery(queries.audience(id));
export const useBilling = () => useQuery(queries.billing());
export const useVoices = () => useQuery(queries.voices());

// ---- mutations -------------------------------------------------------------

/** Writes a fresh channel into both the detail and list caches. */
export function putChannel(channel: ChannelDto): void {
  queryClient.setQueryData(keys.channel(channel.id), channel);
  queryClient.setQueryData<ChannelListItem[]>(keys.channels, (list) =>
    list?.map((item) => (item.id === channel.id ? { ...item, ...channel } : item)),
  );
}

function snapshot(keysToSave: QueryKey[]) {
  const saved = keysToSave.map((key) => [key, queryClient.getQueryData(key)] as const);
  return () => saved.forEach(([key, data]) => queryClient.setQueryData(key, data));
}

/**
 * Saves channel fields optimistically: the UI (and the engine preview)
 * update at once; a failure rolls back and explains why.
 */
export function useUpdateChannel(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ["update-channel", id],
    mutationFn: async (patch: ChannelUpdateInput) =>
      (await call(api.api.channels[":id"].$patch({ param: { id }, json: patch }))).channel as ChannelDto,
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: keys.channel(id), exact: true });
      const restore = snapshot([keys.channel(id), keys.channels]);
      const current = client.getQueryData<ChannelDto>(keys.channel(id));
      if (current) putChannel({ ...current, ...(patch as Partial<ChannelDto>) });
      return { restore };
    },
    onError: (error, _patch, context) => {
      context?.restore();
      toast.error("Não deu para salvar", error);
    },
    onSuccess: (channel) => putChannel(channel),
  });
}

export function useCreateChannel() {
  return useMutation({
    mutationFn: async (input: ChannelCreateInput) => {
      try {
        return (await call(api.api.channels.$post({ json: input }))).channel as ChannelDto;
      } catch (error) {
        // The browser's time zone is a nicety: if this server doesn't know it, create the host without one.
        if (!(input.timezone && error instanceof ApiError && error.status === 400)) throw error;
        const { timezone: _unknown, ...rest } = input;
        return (await call(api.api.channels.$post({ json: rest }))).channel as ChannelDto;
      }
    },
    onSuccess: (channel) => {
      queryClient.setQueryData(keys.channel(channel.id), channel);
      void queryClient.invalidateQueries({ queryKey: keys.channels, exact: true });
    },
  });
}

export function useDeleteChannel() {
  return useMutation({
    mutationFn: async (id: string) => {
      await call(api.api.channels[":id"].$delete({ param: { id } }));
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<ChannelListItem[]>(keys.channels, (list) => list?.filter((c) => c.id !== id));
      queryClient.removeQueries({ queryKey: keys.channel(id) });
    },
  });
}

/** Go live / stop, optimistic on the status so the button responds instantly. */
export function useRunChannel(id: string) {
  return useMutation({
    mutationFn: async (action: "start" | "stop") => {
      const route = api.api.channels[":id"][action];
      return (await call(route.$post({ param: { id } }))).channel as ChannelDto;
    },
    onMutate: (action) => {
      const restore = snapshot([keys.channel(id), keys.channels]);
      const current = queryClient.getQueryData<ChannelDto>(keys.channel(id));
      if (current) {
        putChannel({
          ...current,
          desiredState: action === "start" ? "running" : "stopped",
          runtime: { ...current.runtime, status: action === "start" ? "starting" : "stopping" },
        });
      }
      return { restore };
    },
    onError: (error, action, context) => {
      context?.restore();
      toast.error(action === "start" ? "Não deu para entrar ao vivo" : "Não deu para parar", error);
    },
    onSuccess: (channel) => putChannel(channel),
  });
}

export function useRotateStageKey(id: string) {
  return useMutation({
    mutationFn: async () => (await call(api.api.channels[":id"]["stage-key"].$post({ param: { id } }))).channel as ChannelDto,
    onSuccess: (channel) => putChannel(channel),
    onError: (error) => toast.error("Não deu para trocar o link", error),
  });
}

export function useUpdateBroadcast(id: string) {
  return useMutation({
    mutationFn: async (input: { enabled?: boolean; rtmpUrl?: string | null; streamKey?: string | null }) =>
      (await call(api.api.channels[":id"].broadcast.$put({ param: { id }, json: input }))).channel as ChannelDto,
    onSuccess: (channel) => putChannel(channel),
  });
}
