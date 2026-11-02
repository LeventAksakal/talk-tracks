import { StateNote } from "../brand/states";
import { Link } from "../router";

export function NotFound({ what = "There is no page here." }: { what?: string }) {
  return (
    <main className="page-pad" id="main">
      <StateNote title="Not found">
        <p>{what}</p>
        <p>
          <Link href="/">Back to the hub</Link>
        </p>
      </StateNote>
    </main>
  );
}
