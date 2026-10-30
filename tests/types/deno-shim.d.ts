// Type-check shim only: the Edge Functions run on Deno, the repo type-checks them with tsc.
declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
  env: { get(key: string): string | undefined };
};
