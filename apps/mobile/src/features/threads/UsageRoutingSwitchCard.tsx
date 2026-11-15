import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef, ServerConfig } from "@t3tools/contracts";
import { latestUsageLimitSwitch, providerAccountName } from "@t3tools/shared/usageRouting";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { environmentThreadDetails } from "../../state/threads";
import { updateThreadDraftModelSelection } from "../../state/use-thread-composer-state";

const NO_RUNS = Atom.make(() => null);
const runsAtom = Atom.family((ref: ScopedThreadRef) =>
  Atom.make((get) => get(environmentThreadDetails.quietThreadAtom(ref))?.projection.runs ?? null),
);

/** Usage-aware routing moved this thread to another account; offers the way back. */
export function UsageRoutingSwitchCard(props: {
  readonly thread: EnvironmentThreadShell;
  readonly threadRef: ScopedThreadRef | null;
  readonly serverConfig: ServerConfig | null;
}) {
  const runs = useAtomValue(props.threadRef === null ? NO_RUNS : runsAtom(props.threadRef));
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const accountSwitch = runs === null ? null : latestUsageLimitSwitch(runs);
  if (accountSwitch === null) return null;
  const key = `${accountSwitch.from.instanceId}:${accountSwitch.to.instanceId}`;
  // Once the thread or the user moves off the routed account, the notice has nothing to offer.
  if (closedFor === key || props.thread.modelSelection.instanceId !== accountSwitch.to.instanceId)
    return null;
  const accountName = (instanceId: string) => {
    const provider = props.serverConfig?.providers.find((entry) => entry.instanceId === instanceId);
    return provider ? providerAccountName(provider) : instanceId;
  };
  const from = accountName(accountSwitch.from.instanceId);
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
        <CardAction
          label={`Switch back to ${from}`}
          onPress={() => {
            updateThreadDraftModelSelection(
              scopedThreadKey(props.thread.environmentId, props.thread.id),
              accountSwitch.from,
            );
            setClosedFor(key);
          }}
        />
        <CardAction label="Dismiss" onPress={() => setClosedFor(key)} />
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
