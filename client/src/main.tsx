import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ToastProvider } from "./components/toast";
import { createTrpcClient, errorCode, trpc } from "./lib/trpc";
import "./styles.css";

function Providers() {
  const [queryClient] = useState(() => {
    const client: QueryClient = new QueryClient({
      queryCache: new QueryCache({
        onError: (err) => {
          // Session expired or membership revoked: re-resolve who we are.
          const code = errorCode(err);
          if (code === "UNAUTHORIZED" || code === "FORBIDDEN") {
            void client.invalidateQueries({ queryKey: [["auth", "me"]] });
          }
        },
      }),
      mutationCache: new MutationCache({
        onError: (err) => {
          if (errorCode(err) === "UNAUTHORIZED")
            void client.invalidateQueries({ queryKey: [["auth", "me"]] });
        },
      }),
      defaultOptions: {
        queries: {
          staleTime: 15_000,
          retry: (count, err) =>
            !["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "BAD_REQUEST"].includes(errorCode(err) ?? "") &&
            count < 2,
          refetchOnWindowFocus: true,
        },
      },
    });
    return client;
  });
  const [trpcClient] = useState(createTrpcClient);
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ToastProvider>
            <App />
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers />
  </StrictMode>,
);
