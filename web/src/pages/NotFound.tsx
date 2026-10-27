import { Link } from "../router";

export function NotFound({ what = "There is no page here." }: { what?: string }) {
  return (
    <main className="page-pad" id="main">
      <h1>Not found</h1>
      <p>{what}</p>
      <p>
        <Link href="/">Back to the start</Link>
      </p>
    </main>
  );
}
