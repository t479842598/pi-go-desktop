/**
 * Frame assembly.
 *
 * ZCode's conversation topic speaks in frames:
 *   { topic, subscriptionId, fromSeq, toSeq, sentAt, payload }
 * where `payload` is either a full snapshot or a batch of deltas.
 *
 * A frame builder owns the two monotonic counters a subscription needs
 * (`seq` per delivery, `revision` per state change) so the projection store on
 * the other side can ACK and detect gaps. It does not own the rows themselves —
 * those live in ./projection.
 */

import { randomUUID } from "node:crypto";

import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";

import type { ProjectedDelta, ProjectedRow } from "./projection.js";
import { buildConversationSnapshot } from "./snapshot.js";
import type { PiSessionView } from "./session-view.js";

export interface ConversationFrame {
  topic: string;
  subscriptionId: string;
  fromSeq: number;
  toSeq: number;
  sentAt: number;
  payload:
    | { kind: "snapshot"; snapshot: Record<string, unknown> }
    | { kind: "deltas"; deltas: ProjectedDelta[] };
}

/**
 * A frame as it travels on the wire.
 *
 * `onDynamicConversationFrame` carries `ConversationTopicWireCandidate`, not the
 * bare frame: the UI's store only decodes this envelope, and a bare frame is
 * rejected as an invalid payload — which the store then treats as a content
 * fault, discarding the draft binding and leaving the composer disabled.
 *
 * `complete` is used because a logical frame here is always one physical frame;
 * the `fragment` variant only exists for frames over the size limit.
 */
export interface ConversationWireFrame {
  wireVersion: number;
  kind: "complete";
  deliveryKind: "initial" | "online" | "recovery";
  logicalFrameId: string;
  logicalFrameOrdinal: number;
  topic: string;
  subscriptionId: string;
  frame: ConversationFrame;
}

export function toWireFrame(
  frame: ConversationFrame,
  ordinal: number,
  deliveryKind: "initial" | "online" | "recovery" = "online",
): ConversationWireFrame {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind,
    logicalFrameId: randomUUID(),
    logicalFrameOrdinal: ordinal,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    frame,
  };
}

export function conversationTopic(sessionId: string): string {
  return `conversation/${sessionId}`;
}

/**
 * One subscription's frame stream.
 *
 * `snapshot()` is for the first frame and every resync; `deltas()` for
 * incremental updates. Sequence numbers advance on every frame so the client's
 * ACK barrier and gap detection work exactly as they do against the real CLI.
 */
export class ConversationFrameBuilder {
  private seq = 0;
  private revision = 0;
  /** Wire ordinal; independent of `seq` so a resync snapshot never reuses one. */
  private ordinal = 0;
  private readonly topic: string;

  constructor(
    private readonly sessionId: string,
    private readonly subscriptionId: string,
  ) {
    this.topic = conversationTopic(sessionId);
  }

  /** Bump the revision for a state change and return it. */
  nextRevision(): number {
    return ++this.revision;
  }

  snapshot(view: PiSessionView, rows: ProjectedRow[]): ConversationFrame {
    const toSeq = ++this.seq;
    const revision = this.nextRevision();
    return {
      topic: this.topic,
      subscriptionId: this.subscriptionId,
      fromSeq: 0,
      toSeq,
      sentAt: Date.now(),
      payload: {
        kind: "snapshot",
        snapshot: buildConversationSnapshot({
          view,
          rows,
          seq: toSeq,
          revision,
          title: view.title,
        }),
      },
    };
  }

  deltas(deltas: ProjectedDelta[]): ConversationFrame | null {
    if (deltas.length === 0) return null;
    const fromSeq = this.seq;
    const toSeq = ++this.seq;
    return {
      topic: this.topic,
      subscriptionId: this.subscriptionId,
      fromSeq,
      toSeq,
      sentAt: Date.now(),
      payload: { kind: "deltas", deltas },
    };
  }

  get currentSeq(): number {
    return this.seq;
  }

  /**
   * Wrap the next frame for the wire.
   *
   * `logicalFrameOrdinal` is its own monotonically increasing counter, NOT the
   * sequence number. The assembler remembers the last ordinal it settled per
   * route: reusing a sequence-derived value made a resync's snapshot collide with
   * an already-settled frame (`frameAssemblyOrdinalConflict`), and restarting a
   * counter made it go backwards (`frameAssemblyMetadataMismatch`).
   */
  wrap(frame: ConversationFrame): ConversationWireFrame {
    this.ordinal += 1;
    return toWireFrame(frame, this.ordinal, this.ordinal === 1 ? "initial" : "online");
  }
}
