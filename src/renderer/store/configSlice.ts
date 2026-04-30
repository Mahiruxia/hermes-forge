import { combine } from "zustand/middleware";
import type {
  ClientInfo,
  EngineId,
  EngineRuntimeProfile,
  HermesProbeSummary,
  HermesStatusSummary,
  HermesWebUiOverview,
  ModelProviderProfile,
  PermissionOverview,
  RuntimeConfig,
  SecretVaultStatus,
  SetupSummary,
} from "../../shared/types";
import type { EngineWarmupState } from "../store";

export interface ConfigState {
  clientInfo?: ClientInfo;
  runtimeConfig?: RuntimeConfig;
  providerProfiles: ModelProviderProfile[];
  engineRuntimeProfiles: Partial<Record<EngineId, Partial<EngineRuntimeProfile>>>;
  hermesStatus?: HermesStatusSummary;
  hermesProbe?: HermesProbeSummary;
  hermesWarmup?: EngineWarmupState;
  setupSummary?: SetupSummary;
  secretStatus?: SecretVaultStatus;
  webUiOverview?: HermesWebUiOverview;
  permissionOverview?: PermissionOverview;
}

export interface ConfigActions {
  setClientInfo(clientInfo: ClientInfo): void;
  setRuntimeConfig(runtimeConfig: RuntimeConfig): void;
  setProviderProfiles(profiles: ModelProviderProfile[]): void;
  setEngineRuntimeProfile(engineId: EngineId, profile: Partial<EngineRuntimeProfile>): void;
  setHermesStatus(status: HermesStatusSummary): void;
  setHermesProbe(probe: HermesProbeSummary): void;
  setHermesWarmup(warmup: EngineWarmupState): void;
  setSetupSummary(setupSummary: SetupSummary): void;
  setSecretStatus(secretStatus: SecretVaultStatus): void;
  setWebUiOverview(overview?: HermesWebUiOverview): void;
  setPermissionOverview(overview?: PermissionOverview): void;
}

export const configSlice = combine<ConfigState, ConfigActions>(
  {
    clientInfo: undefined,
    runtimeConfig: undefined,
    providerProfiles: [],
    engineRuntimeProfiles: {},
    hermesStatus: undefined,
    hermesProbe: undefined,
    hermesWarmup: undefined,
    setupSummary: undefined,
    secretStatus: undefined,
    webUiOverview: undefined,
    permissionOverview: undefined,
  },
  (set) => ({
    setClientInfo: (clientInfo: ClientInfo) => set({ clientInfo }),
    setRuntimeConfig: (runtimeConfig: RuntimeConfig) => set({ runtimeConfig }),
    setProviderProfiles: (profiles: ModelProviderProfile[]) => set({ providerProfiles: profiles }),
    setEngineRuntimeProfile: (engineId: EngineId, profile: Partial<EngineRuntimeProfile>) =>
      set((state) => ({
        engineRuntimeProfiles: { ...state.engineRuntimeProfiles, [engineId]: profile },
      })),
    setHermesStatus: (status: HermesStatusSummary) => set({ hermesStatus: status }),
    setHermesProbe: (probe: HermesProbeSummary) => set({ hermesProbe: probe }),
    setHermesWarmup: (warmup: EngineWarmupState) => set({ hermesWarmup: warmup }),
    setSetupSummary: (setupSummary: SetupSummary) => set({ setupSummary }),
    setSecretStatus: (secretStatus: SecretVaultStatus) => set({ secretStatus }),
    setWebUiOverview: (overview?: HermesWebUiOverview) => set({ webUiOverview: overview }),
    setPermissionOverview: (permissionOverview?: PermissionOverview) => set({ permissionOverview }),
  })
);
