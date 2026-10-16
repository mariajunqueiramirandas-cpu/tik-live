import { isRouteErrorResponse, useRouteError } from "react-router";
import { ApiError } from "../lib/api";
import { ButtonLink, Button } from "../ui/Button";
import { Empty } from "../ui/Display";

/** Per-route error boundary: one failing screen never blanks the app. */
export function RouteError() {
  const error = useRouteError();
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div style={{ padding: "var(--s-8)" }}>
        <Empty title="This host doesn't exist" action={<ButtonLink to="/app">Back to your hosts</ButtonLink>}>
          <p>It may have been deleted, or the link is wrong.</p>
        </Empty>
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 401) {
    return (
      <div style={{ padding: "var(--s-8)" }}>
        <Empty title="Sign in to continue" action={<Button onClick={() => location.reload()}>Try again</Button>} />
      </div>
    );
  }
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Something went wrong.";
  const stale = error instanceof Error && /dynamically imported module|Importing a module script failed/i.test(error.message);
  return (
    <div style={{ padding: "var(--s-8)" }}>
      <Empty
        title={stale ? "A new version is available" : "This screen didn't load"}
        action={<Button onClick={() => location.reload()}>{stale ? "Reload" : "Try again"}</Button>}
      >
        <p>{stale ? "Lantern was updated while this tab was open." : message}</p>
      </Empty>
    </div>
  );
}

export function NotFound() {
  return (
    <div style={{ padding: "var(--s-8)" }}>
      <Empty title="Nothing here" action={<ButtonLink to="/app">Back to your hosts</ButtonLink>}>
        <p>That page doesn't exist.</p>
      </Empty>
    </div>
  );
}
