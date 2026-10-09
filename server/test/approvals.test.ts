import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canTransition } from "../src/modules/approvals/service";
import { addMember, createOrg } from "./helpers";

async function setup() {
  const ctx = await createOrg();
  const manager = await addMember(ctx.org.id, ctx.owner, "MANAGER", "Max Manager");
  const member = await addMember(ctx.org.id, ctx.owner, "MEMBER", "Mia Member");
  const leave = (approverUserId = manager.id) =>
    ctx.as(member).approvals.create({
      type: "LEAVE",
      title: "Summer holiday",
      approverUserId,
      payload: { leaveType: "ANNUAL", startDate: "2026-07-01", endDate: "2026-07-10" },
    });
  return { ...ctx, manager, member, leave };
}

describe("approval engine", () => {
  it("state machine only leaves PENDING", () => {
    expect(canTransition("PENDING", "APPROVED")).toBe(true);
    expect(canTransition("PENDING", "CANCELLED")).toBe(true);
    expect(canTransition("APPROVED", "REJECTED")).toBe(false);
    expect(canTransition("REJECTED", "APPROVED")).toBe(false);
    expect(canTransition("CANCELLED", "PENDING")).toBe(false);
  });

  it("runs request → approve with history, audit and notifications", async () => {
    const { owner, manager, member, as, leave } = await setup();
    const req = await leave();
    expect(req.status).toBe("PENDING");

    const inbox = await as(manager).approvals.list({ box: "inbox" });
    expect(inbox.items.map((r) => r.id)).toContain(req.id);
    expect((await as(manager).notifications.list({})).items[0]).toMatchObject({ type: "APPROVAL_REQUESTED" });
    expect((await as(manager).approvals.get({ id: req.id })).canDecide).toBe(true);
    expect((await as(member).approvals.get({ id: req.id })).canDecide).toBe(false);

    const decided = await as(manager).approvals.decide({
      id: req.id,
      decision: "APPROVED",
      comment: "Enjoy",
    });
    expect(decided).toMatchObject({ status: "APPROVED", decisionComment: "Enjoy" });
    expect(decided.decidedAt).toBeInstanceOf(Date);

    const detail = await as(member).approvals.get({ id: req.id });
    expect(detail.events.map((e) => e.kind)).toEqual(["CREATED", "APPROVED"]);
    expect((await as(member).notifications.list({})).items[0]).toMatchObject({ type: "APPROVAL_DECIDED" });
    const log = await as(owner).audit.list({ entityType: "approval" });
    expect(log.items.map((e) => e.action)).toEqual(
      expect.arrayContaining(["approval.requested", "approval.approved"]),
    );
  });

  it("prevents duplicate and conflicting decisions, including concurrent ones", async () => {
    const { manager, as, leave } = await setup();
    const req = await leave();
    const results = await Promise.allSettled([
      as(manager).approvals.decide({ id: req.id, decision: "APPROVED" }),
      as(manager).approvals.decide({ id: req.id, decision: "REJECTED", comment: "no" }),
      as(manager).approvals.decide({ id: req.id, decision: "APPROVED" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });
    }
    const detail = await as(manager).approvals.get({ id: req.id });
    expect(detail.events.filter((e) => e.kind !== "CREATED")).toHaveLength(1);
  });

  it("only the designated approver may decide", async () => {
    const { owner, org, member, as, leave } = await setup();
    const otherManager = await addMember(org.id, owner, "MANAGER", "Other Manager");
    const req = await leave();
    await expect(
      as(otherManager).approvals.decide({ id: req.id, decision: "APPROVED" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Admin with read_all sees it but still cannot decide on behalf of the approver.
    await expect(as(owner).approvals.decide({ id: req.id, decision: "APPROVED" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(as(member).approvals.decide({ id: req.id, decision: "APPROVED" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("validates approver eligibility and payloads", async () => {
    const { owner, org, member, as, leave } = await setup();
    const peer = await addMember(org.id, owner, "MEMBER", "Peer");
    await expect(leave(peer.id)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(leave(member.id)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const outsider = await createOrg();
    await expect(leave(outsider.owner.id)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as(member).approvals.create({
        type: "LEAVE",
        title: "Backwards",
        approverUserId: owner.id,
        payload: { leaveType: "ANNUAL", startDate: "2026-07-10", endDate: "2026-07-01" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as(member).approvals.create({
        type: "PURCHASE",
        title: "Laptop",
        approverUserId: owner.id,
        payload: { amount: -5, currency: "EUR", vendor: "X" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejection requires a reason; requester can cancel only while pending", async () => {
    const { manager, member, as, leave } = await setup();
    const req = await leave();
    await expect(as(manager).approvals.decide({ id: req.id, decision: "REJECTED" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(as(manager).approvals.cancel({ id: req.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await as(member).approvals.cancel({ id: req.id });
    await expect(as(member).approvals.cancel({ id: req.id })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(as(manager).approvals.decide({ id: req.id, decision: "APPROVED" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("hides requests from uninvolved members and other organizations", async () => {
    const { owner, org, as, leave } = await setup();
    const bystander = await addMember(org.id, owner, "MEMBER", "Bystander");
    const req = await leave();
    await expect(as(bystander).approvals.get({ id: req.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await as(bystander).approvals.list({ box: "all" })).total).toBe(0);
    await expect(as(bystander).approvals.comment({ id: req.id, comment: "hi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await as(owner).approvals.list({ box: "all" })).total).toBe(1);

    const other = await createOrg();
    await expect(other.as(other.owner).approvals.get({ id: req.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      other.as(other.owner).approvals.decide({ id: req.id, decision: "APPROVED" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("approver list excludes the requester and non-deciders", async () => {
    const { manager, member, owner, as } = await setup();
    const approvers = await as(member).approvals.approvers();
    const ids = approvers.map((a) => a.userId);
    expect(ids).toEqual(expect.arrayContaining([manager.id, owner.id]));
    expect(ids).not.toContain(member.id);
    const unknown = randomUUID();
    await expect(
      as(member).approvals.create({ type: "GENERAL", title: "x", approverUserId: unknown }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
