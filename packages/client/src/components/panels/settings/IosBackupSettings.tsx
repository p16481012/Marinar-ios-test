import { useRef, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArchiveRestore, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  useCreateIosBackup,
  useIosBackupStatus,
  useIosRestoreStatus,
  useStageIosRestore,
} from "../../../hooks/use-ios-backup";
import { showConfirmDialog } from "../../../lib/app-dialogs";
import { saveExportUrl } from "../../../lib/file-download";

const buttonClass =
  "flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[var(--secondary)] px-3 py-2 text-xs font-medium ring-1 ring-[var(--border)] hover:bg-[var(--accent)] disabled:opacity-50";

export function IosBackupSettings() {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const backup = useIosBackupStatus();
  const restore = useIosRestoreStatus();
  const create = useCreateIosBackup();
  const stage = useStageIosRestore();
  const busy =
    create.isPending || backup.data?.status === "preparing" || stage.isPending || restore.data?.restartRequired;
  const showError = (error: unknown) =>
    toast.error(t("ios.backup.failed"), {
      description: error instanceof Error ? error.message : undefined,
    });

  async function selectRestore(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1024 ** 3) {
      toast.error(t("ios.backup.tooLarge"));
      return;
    }
    const confirmed = await showConfirmDialog({
      title: t("ios.backup.restore"),
      message: t("ios.backup.confirm", { filename: file.name }),
      confirmLabel: t("ios.backup.validate"),
      cancelLabel: t("chat.delete.dialog.cancel"),
      tone: "destructive",
    });
    if (!confirmed) return;
    try {
      await stage.mutateAsync(file);
    } catch (error) {
      showError(error);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="ios-backup-settings">
      <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{t("ios.backup.description")}</p>
      <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{t("ios.backup.private")}</p>
      <button
        type="button"
        className={buttonClass}
        disabled={busy || backup.isLoading || backup.isError}
        onClick={() => create.mutate(undefined, { onError: showError })}
      >
        {create.isPending || backup.data?.status === "preparing" ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Download size={16} />
        )}
        {t(backup.data?.status === "preparing" ? "ios.backup.preparing" : "ios.backup.create")}
      </button>
      {backup.data?.status === "ready" && backup.data.downloadUrl && (
        <button
          type="button"
          className={buttonClass}
          disabled={stage.isPending || restore.data?.restartRequired}
          onClick={() =>
            void saveExportUrl(backup.data!.downloadUrl!, backup.data?.filename ?? "marinar-ios-backup.zip")
          }
        >
          <Download size={16} />
          {t("ios.backup.save")}
        </button>
      )}
      <button
        type="button"
        className={buttonClass}
        disabled={busy || restore.isLoading || restore.isError}
        onClick={() => input.current?.click()}
      >
        {stage.isPending ? <Loader2 size={16} className="animate-spin" /> : <ArchiveRestore size={16} />}
        {t(stage.isPending ? "ios.backup.validating" : "ios.backup.restore")}
      </button>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={selectRestore}
      />
      <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{t("ios.backup.formats")}</p>
      {backup.data?.error && (
        <p role="alert" className="break-words text-xs text-[var(--destructive)]">
          {backup.data.error}
        </p>
      )}
      {(backup.isError || restore.isError) && (
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            void backup.refetch();
            void restore.refetch();
          }}
        >
          {t("ios.backup.retry")}
        </button>
      )}
      {restore.data && ["applied", "rolled-back", "failed"].includes(restore.data.status) && (
        <p role="status" className="break-words text-xs">
          {t(`ios.restore.${restore.data.status === "rolled-back" ? "rolledBack" : restore.data.status}`)}{" "}
          {restore.data.message}
        </p>
      )}
    </div>
  );
}
