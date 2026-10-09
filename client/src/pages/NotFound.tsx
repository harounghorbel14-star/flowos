import { Link } from "react-router-dom";
import { EmptyState } from "../components/ui";

export function NotFoundPage({ what = "page" }: { what?: string }) {
  return (
    <div className="panel">
      <EmptyState
        title={`This ${what} could not be found`}
        action={
          <Link className="btn" to="/">
            Back to command center
          </Link>
        }
      >
        It may have been deleted, or it belongs to an organization you are not currently working in.
      </EmptyState>
    </div>
  );
}
