import Link from "next/link";

export const metadata = {
  title: "Fractional DPO",
};

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-16">
      <p className="text-xs uppercase tracking-widest text-slate-500">Fractional DPO</p>
      <h1 className="mt-3 text-2xl font-semibold">Not found</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        This page is not available from the current session.
      </p>
      <p className="mt-5">
        <Link href="/" className="text-sm underline">
          Go to portfolio
        </Link>
      </p>
    </main>
  );
}
