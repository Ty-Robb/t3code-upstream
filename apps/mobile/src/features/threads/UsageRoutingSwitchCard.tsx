import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef, ServerConfig } from "@t3tools/contracts";
import { latestUsageLimitSwitch, providerAccountName } from "@t3tools/shared/usageRouting";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { threadAllowsProviderSwitch } from "../../state/thread-provider-switching";
import { useComposerDraftSettings } from "../../state/use-composer-drafts";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { selectThreadModel } from "../../state/thread-model-selection";

/** Usage-aware routing moved this thread to another account; offers the way back. */
export function UsageRoutingSwitchCard(props: {
  readonly thread: EnvironmentThreadShell;
  readonly threadRef: ScopedThreadRef | null;
  readonly serverConfig: ServerConfig | null;
}) {
  const structure = useQuietThreadStructure(props.threadRef);
  const draftKey = scopedThreadKey(props.thread.environmentId, props.thread.id);
  const draftModel = useComposerDraftSettings(draftKey).modelSelection;
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const accountSwitch = structure ? latestUsageLimitSwitch(structure.projection.runs) : null;
  if (accountSwitch === null) return null;
  const key = `${accountSwitch.from.instanceId}:${accountSwitch.to.instanceId}`;
  // Like web, the notice lasts only while the next message would still go to the routed model.
  const next = draftModel ?? props.thread.modelSelection;
  if (
    dismissedFor === key ||
    next.instanceId !== accountSwitch.to.instanceId ||
    next.model !== accountSwitch.to.model
  )
    return null;
  const accountName = (instanceId: string) => {
    const provider = props.serverConfig?.providers.find((entry) => entry.instanceId === instanceId);
    return provider ? providerAccountName(provider) : instanceId;
  };
  const from = accountName(accountSwitch.from.instanceId);
  // The settings sheet locks the account under the same rule, so the card never offers more.
  const canSwitchBack = threadAllowsProviderSwitch({
    thread: props.thread,
    projection: structure?.projection,
  });
  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-border bg-screen p-3">
      <Text className="text-sm font-t3-medium text-foreground">
        Moved to {accountName(accountSwitch.to.instanceId)} after a usage limit
      </Text>
      <Text className="text-sm text-foreground-muted">
        {from} reached its limit. The conversation carried over; tool state from the earlier session
        may not have.
      </Text>
      <View className="-mb-3 -mt-2 flex-row flex-wrap gap-x-4">
        {canSwitchBack ? (
          <CardAction
            label={`Switch back to ${from}`}
            onPress={() =>
              selectThreadModel(
                { environmentId: props.thread.environmentId, threadId: props.thread.id },
                accountSwitch.from,
              )
            }
          />
        ) : null}
        <CardAction label="Dismiss" onPress={() => setDismissedFor(key)} />
      </View>
    </View>
  );
}

function CardAction(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={{ left: 8, right: 8 }}
      onPress={props.onPress}
      className="min-h-11 justify-center active:opacity-70"
    >
      <Text className="text-sm font-t3-medium text-primary">{props.label}</Text>
    </Pressable>
  );
}
