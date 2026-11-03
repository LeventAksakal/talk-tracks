import { StateNote } from "../brand/states";
import { Link } from "../router";

export function NotFound({ what = "There is no page here." }: { what?: string }) {
  return (
    <main className="page-pad" id="main">
      <StateNote title="Not found">
        <p>{what}</p>
        <p>
          <Link href="/">All talks</Link>
        </p>
      </StateNote>
    </main>
  );
}
