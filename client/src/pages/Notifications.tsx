import { Bell, CheckCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/toast";
import { Button, EmptyState, ErrorState, PageHeader, Pagination, SkeletonRows } from "../components/ui";
import { formatDateTime, timeAgo } from "../lib/format";
import { trpc } from "../lib/trpc";

export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const toast = useToast();
  const utils = trpc.useUtils();
  const list = trpc.notifications.list.useQuery(
    { unreadOnly, page, pageSize: 30 },
    { placeholderData: (prev) => prev },
  );
  const markRead = trpc.notifications.markRead.useMutation({
    onSuccess: () => utils.notifications.invalidate(),
    onError: toast.error,
  });

  return (
    <>
      <PageHeader
        eyebrow="Inbox"
        title="Notifications"
        lede="In-app notifications for this organization. Email and push delivery are not configured yet."
        actions={
          <Button onClick={() => markRead.mutate({})} loading={markRead.isPending}>
            <CheckCheck aria-hidden /> Mark all read
          </Button>
        }
      />
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter">
          <button aria-pressed={!unreadOnly} onClick={() => (setUnreadOnly(false), setPage(1))}>
            All
          </button>
          <button aria-pressed={unreadOnly} onClick={() => (setUnreadOnly(true), setPage(1))}>
            Unread
          </button>
        </div>
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.isLoading ? (
        <div className="panel">
          <SkeletonRows />
        </div>
      ) : null}
      {list.data ? (
        <div className="panel">
          {list.data.total === 0 ? (
            <EmptyState
              icon={<Bell size={18} />}
              title={unreadOnly ? "You’re all caught up" : "No notifications yet"}
            >
              You’ll be notified when work is assigned to you, someone comments, or a decision needs you.
            </EmptyState>
          ) : (
            <ul className="list">
              {list.data.items.map((n) => {
                const content = (
                  <>
                    <span
                      className="dot"
                      aria-hidden
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: n.readAt ? "transparent" : "var(--teal)",
                        flexShrink: 0,
                      }}
                    />
                    <div className="grow">
                      <div style={{ fontWeight: n.readAt ? 400 : 600 }}>{n.title}</div>
                      {n.body ? (
                        <div className="muted truncate" style={{ fontSize: 13 }}>
                          {n.body}
                        </div>
                      ) : null}
                    </div>
                    <span
                      className="faint"
                      style={{ fontSize: 12, whiteSpace: "nowrap" }}
                      title={formatDateTime(n.createdAt)}
                    >
                      {timeAgo(n.createdAt)}
                    </span>
                  </>
                );
                return (
                  <li key={n.id}>
                    {n.link ? (
                      <Link
                        to={n.link}
                        className="list-item"
                        onClick={() => !n.readAt && markRead.mutate({ ids: [n.id] })}
                      >
                        {content}
                      </Link>
                    ) : (
                      <div className="list-item">{content}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
      {list.data ? (
        <Pagination
          page={list.data.page}
          pageCount={list.data.pageCount}
          total={list.data.total}
          noun="notifications"
          onPage={setPage}
        />
      ) : null}
    </>
  );
}
