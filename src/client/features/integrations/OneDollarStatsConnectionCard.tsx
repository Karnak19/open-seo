import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BarChart3 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { revalidateLogic } from "@tanstack/react-form";
import { CardShell } from "@/client/components/CardShell";
import { PermissionHint } from "@/client/components/PermissionHint";
import { QueryError } from "@/client/components/QueryState";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import { useAppForm } from "@/client/components/form/useAppForm";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  connectOneDollarStats,
  disconnectOneDollarStats,
  getOneDollarStatsConnection,
} from "@/serverFunctions/onedollarstats";
import { ONE_DOLLAR_STATS_SETUP_DOCS_URL } from "@/shared/onedollarstats";

const oneDollarStatsConnectionQueryKey = (projectId: string) => [
  "oneDollarStatsConnection",
  projectId,
];

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Connects one project to a OneDollarStats site: paste the API key (saved for
 * the organization, so other projects reuse it) and the site's hostname.
 */
function OneDollarStatsConnectForm({
  projectId,
  hasApiKey,
  onSaved,
}: {
  projectId: string;
  hasApiKey: boolean;
  onSaved: () => void;
}) {
  const connectSchema = z.object({
    apiKey: hasApiKey
      ? z.string().trim()
      : z.string().trim().min(1, "Enter the OneDollarStats API key."),
    siteId: z.string().trim().min(1, "Enter the site's hostname."),
  });

  const connectMutation = useMutation({
    mutationFn: (values: z.infer<typeof connectSchema>) =>
      connectOneDollarStats({
        data: {
          projectId,
          apiKey: values.apiKey ? values.apiKey : undefined,
          siteId: values.siteId,
          timeZone: browserTimeZone(),
        },
      }),
  });

  const form = useAppForm({
    defaultValues: { apiKey: "", siteId: "" },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: connectSchema },
    onSubmit: async ({ value, formApi }) => {
      const result = await connectMutation.mutateAsync(value);
      if ("problem" in result) {
        formApi.setErrorMap({
          onSubmit: {
            fields: {
              [result.problem.code === "onedollarstats_key_rejected"
                ? "apiKey"
                : "siteId"]: result.problem.message,
            },
          },
        });
        return;
      }
      formApi.reset();
      toast.success("OneDollarStats connected");
      onSaved();
    },
  });

  return (
    <form.AppForm>
      <form.Form className="space-y-3">
        <form.AppField name="apiKey">
          {(field) => (
            <field.TextField
              label="API key"
              description={
                hasApiKey
                  ? "Leave blank to reuse the key saved for your organization."
                  : "Create one in OneDollarStats under Account settings → API Keys. It is saved for your organization, so other projects reuse it."
              }
              type="password"
              autoComplete="off"
              data-ph-mask
              className="font-mono"
              placeholder="ods_…"
            />
          )}
        </form.AppField>
        <form.AppField name="siteId">
          {(field) => (
            <field.TextField
              label="Site hostname"
              description="The domain exactly as configured in OneDollarStats."
              placeholder="example.com"
              className="font-mono"
              required
            />
          )}
        </form.AppField>
        <form.SubmitButton>
          {connectMutation.isPending ? "Connecting…" : "Connect site"}
        </form.SubmitButton>
      </form.Form>
    </form.AppForm>
  );
}

/**
 * The project's OneDollarStats connection: connect a site, change it, or
 * disconnect it.
 */
export function OneDollarStatsConnectionCard({
  projectId,
}: {
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = oneDollarStatsConnectionQueryKey(projectId);
  const connectionQuery = useQuery({
    queryKey,
    queryFn: () => getOneDollarStatsConnection({ data: { projectId } }),
  });
  const connection = connectionQuery.data;
  const [isChanging, setIsChanging] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries({ queryKey: ["dashboardOdsReport"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboardActivation"] }),
    ]);

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectOneDollarStats({ data: { projectId } }),
    onSuccess: refresh,
  });

  const canManage = connection?.canManage === true;
  const busy = disconnectMutation.isPending;

  return (
    <CardShell
      title="OneDollarStats"
      icon={<BarChart3 className="size-5" />}
      action={
        connection ? (
          <Badge variant={connection.connected ? "success" : "outline"}>
            <span className="size-1.5 rounded-full bg-current" />
            {connection.connected ? "Connected" : "Not connected"}
          </Badge>
        ) : undefined
      }
    >
      {connectionQuery.isPending ? (
        <div
          role="status"
          aria-label="Loading connection"
          className="space-y-3"
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-9 w-24" />
        </div>
      ) : !connection ? (
        <QueryError
          error={connectionQuery.error}
          fallback="Couldn't check this project's OneDollarStats connection."
          onRetry={() => void connectionQuery.refetch()}
          isRetrying={connectionQuery.isFetching}
        />
      ) : !connection.encryptionConfigured ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>Credential encryption not configured</AlertTitle>
          <AlertDescription>
            <p>
              Set BETTER_AUTH_SECRET (32+ characters) on this OpenSEO
              deployment. It encrypts the OneDollarStats API key.
            </p>
            <SafeExternalLink
              url={ONE_DOLLAR_STATS_SETUP_DOCS_URL}
              label="Open setup guide"
              className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
            />
          </AlertDescription>
        </Alert>
      ) : (
        <fieldset disabled={busy} className="space-y-4">
          {connection.connected && !isChanging ? (
            <div className="space-y-4">
              <p className="break-all text-sm font-semibold">
                {connection.siteId}
              </p>
              {canManage ? (
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsChanging(true)}
                  >
                    Change site
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => disconnectMutation.mutate()}
                  >
                    {disconnectMutation.isPending
                      ? "Disconnecting…"
                      : "Disconnect project"}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {canManage && (!connection.connected || isChanging) ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Read visits, visitors, and traffic sources from your
                OneDollarStats sites.
              </p>
              <OneDollarStatsConnectForm
                projectId={projectId}
                hasApiKey={connection.hasApiKey}
                onSaved={() => {
                  void refresh();
                  setIsChanging(false);
                }}
              />
              {isChanging ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsChanging(false)}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          ) : null}
        </fieldset>
      )}
      {disconnectMutation.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {getStandardErrorMessage(disconnectMutation.error)}
        </p>
      ) : null}
      {connection && !canManage ? (
        <PermissionHint
          action="change this project's connection"
          className="mt-3"
        />
      ) : null}
    </CardShell>
  );
}
