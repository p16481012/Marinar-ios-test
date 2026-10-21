import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IosBackupStatus, IosRestoreStatus } from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { isNativeIosApp } from "../lib/ios-runtime";

const backupKey = ["ios", "backup"] as const;
const restoreKey = ["ios", "restore"] as const;

export function useIosBackupStatus() {
  return useQuery({
    queryKey: backupKey,
    queryFn: () => api.get<IosBackupStatus>("/ios/backup/status"),
    enabled: isNativeIosApp(),
    refetchInterval: (query) => (query.state.data?.status === "preparing" ? 1000 : false),
    retry: 1,
  });
}

export function useIosRestoreStatus() {
  return useQuery({
    queryKey: restoreKey,
    queryFn: () => api.get<IosRestoreStatus>("/ios/restore/status"),
    enabled: isNativeIosApp(),
    staleTime: 30_000,
    // A disconnected upload can still finish staging on the server. Reconcile
    // while visible so the global restart/cancel dialog cannot remain hidden.
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

export function useCreateIosBackup() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<IosBackupStatus>("/ios/backup/start", {}),
    onSuccess: () => {
      cache.setQueryData<IosBackupStatus>(backupKey, { status: "preparing" });
      return cache.invalidateQueries({ queryKey: backupKey });
    },
    onError: () => cache.invalidateQueries({ queryKey: backupKey }),
  });
}

export function useStageIosRestore() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const data = new FormData();
      data.append("file", file);
      return api.upload<IosRestoreStatus>("/ios/restore/stage", data, {
        headers: { "x-marinara-confirm-restore": "1" },
      });
    },
    onSuccess: (status) => cache.setQueryData(restoreKey, status),
    // The server may have staged the archive even if the response was interrupted.
    onError: () => cache.invalidateQueries({ queryKey: restoreKey }),
  });
}

export function useCancelIosRestore() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<IosRestoreStatus>("/ios/restore/stage"),
    onSuccess: (status) => cache.setQueryData(restoreKey, status),
    onError: () => cache.invalidateQueries({ queryKey: restoreKey }),
  });
}
