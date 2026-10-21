// ──────────────────────────────────────────────
// Game: Session Lifecycle Service
// ──────────────────────────────────────────────

import type { SessionSummary } from "@marinara-engine/shared";

function normalizeRecapBeat(text: string | null | undefined): string {
  if (!text) return "";

  return text
    .replace(/\[(?:\/)?[^\]]+\]/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildLatestSessionContinuity(summaries: SessionSummary[]): string[] {
  const latest = summaries[summaries.length - 1];
  if (!latest) return [];

  return [
    ...(latest.resumePoint ? [`Resume point: ${latest.resumePoint}`] : []),
    ...(latest.partyDynamics ? [`Party dynamics: ${latest.partyDynamics}`] : []),
    ...(latest.keyDiscoveries.length ? [`Key discoveries: ${latest.keyDiscoveries.join("; ")}`] : []),
    ...(latest.characterMoments?.length ? [`Character moments: ${latest.characterMoments.join("; ")}`] : []),
    ...(latest.littleDetails?.length ? [`Little details to recall: ${latest.littleDetails.join("; ")}`] : []),
    ...(latest.npcUpdates?.length ? [`NPC updates: ${latest.npcUpdates.join("; ")}`] : []),
    ...(latest.nextSessionRequest ? [`Player request for this session: ${latest.nextSessionRequest}`] : []),
    ...(latest.statsSnapshot && Object.keys(latest.statsSnapshot).length > 0
      ? [`Stats snapshot: ${JSON.stringify(latest.statsSnapshot)}`]
      : []),
  ];
}

/**
 * Build the context string that is injected into a new session's chat
 * so the GM and agents have continuity from prior sessions.
 */
export function buildSessionCarryoverContext(summaries: SessionSummary[]): string {
  if (summaries.length === 0) return "";

  const sorted = [...summaries].sort((a, b) => a.sessionNumber - b.sessionNumber);
  const latest = sorted[sorted.length - 1]!;

  const sections: string[] = [
    `<previous_session_summaries>`,
    `The following are the full summaries of past sessions. Use them to maintain long-term continuity:`,
  ];

  for (const summary of sorted) {
    sections.push(``, `--- Session ${summary.sessionNumber} ---`, summary.summary);
  }

  sections.push(`</previous_session_summaries>`);
  sections.push(
    `<latest_session_continuity>`,
    `Only the most recently completed session contributes detailed carryover fields for the current session.`,
    `Latest completed session: ${latest.sessionNumber}`,
    ...buildLatestSessionContinuity(sorted),
    `</latest_session_continuity>`,
  );
  return sections.join("\n");
}

/**
 * Create a "Previously on..." recap narration prompt for the GM
 * when starting a new session.
 */
export function buildRecapPrompt(summaries: SessionSummary[], latestEndingBeat?: string | null): string {
  const latest = summaries[summaries.length - 1];
  if (!latest) return "";

  const cleanedEndingBeat = normalizeRecapBeat(latestEndingBeat);

  return [
    `Write a dramatic "Previously on..." recap for the players.`,
    `Base it on this session summary:`,
    ``,
    latest.summary,
    ``,
    ...(latest.resumePoint ? [`Resume point: ${latest.resumePoint}`] : []),
    `Party dynamics: ${latest.partyDynamics}`,
    `Party state: ${latest.partyState}`,
    `Key discoveries: ${latest.keyDiscoveries.join(", ")}`,
    ...(latest.characterMoments?.length ? [`Character moments: ${latest.characterMoments.join("; ")}`] : []),
    ...(latest.littleDetails?.length ? [`Little details to recall: ${latest.littleDetails.join("; ")}`] : []),
    ...(latest.npcUpdates?.length ? [`NPC updates: ${latest.npcUpdates.join("; ")}`] : []),
    ...(latest.nextSessionRequest ? [`Player request for the next session: ${latest.nextSessionRequest}`] : []),
    ...(latest.statsSnapshot && Object.keys(latest.statsSnapshot).length > 0
      ? [`Stats snapshot: ${JSON.stringify(latest.statsSnapshot)}`]
      : []),
    ...(cleanedEndingBeat
      ? [
          ``,
          `The final narrated beat immediately before the session ended was:`,
          cleanedEndingBeat,
          `Use that ending beat to anchor the opening situation precisely so the new session starts from the right place.`,
        ]
      : []),
    ``,
    `Write 2–3 paragraphs of engaging recap narration. End with a hook that transitions into the new session.`,
  ].join("\n");
}
