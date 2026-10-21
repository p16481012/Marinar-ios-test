import { useTranslation } from "react-i18next";
import { useCancelIosRestore, useIosRestoreStatus } from "../../hooks/use-ios-backup";
import { Modal } from "../ui/Modal";

/** Keep edits from appearing successful while a validated replacement is pending. */
export function IosRestoreBanner() {
  const { t } = useTranslation();
  const status = useIosRestoreStatus();
  const cancel = useCancelIosRestore();
  if (!status.data?.restartRequired) return null;
  return (
    <Modal open onClose={() => {}} closeDisabled topLayer title={t("ios.restore.pending")}>
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed">{t("ios.restore.restart")}</p>
        <button
          type="button"
          autoFocus
          disabled={cancel.isPending}
          className="min-h-11 rounded-lg bg-[var(--secondary)] px-4 py-2 text-sm disabled:opacity-50"
          onClick={() => cancel.mutate()}
        >
          {t("ios.restore.cancel")}
        </button>
        {cancel.error && (
          <p role="alert" className="text-sm text-[var(--destructive)]">
            {cancel.error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}
