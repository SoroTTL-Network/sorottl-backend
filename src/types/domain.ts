import type { xdr } from "@stellar/stellar-sdk";

export type WatchlistKeyType = "instance" | "contractCode" | "contractData";

export interface WatchlistRecord {
  readonly id: number;
  readonly network: string;
  readonly label: string;
  readonly keyType: WatchlistKeyType;
  readonly keyXdr: string;
  readonly contractId?: string | null;
  readonly warningThresholdLedgers: number;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWatchlistInput {
  readonly network: string;
  readonly label: string;
  readonly keyType: WatchlistKeyType;
  readonly keyXdr: string;
  readonly contractId?: string | null;
  readonly warningThresholdLedgers?: number;
}

export interface TTLObservationRecord {
  readonly id: number;
  readonly watchlistId: number;
  readonly network: string;
  readonly currentLedger: number;
  readonly liveUntilLedgerSeq?: number | null;
  readonly remainingLedgers?: number | null;
  readonly lastModifiedLedgerSeq?: number | null;
  readonly status: string; // 'live' | 'ttlReached' | 'unknown'
  readonly durability: string; // 'instance' | 'contractCode' | 'persistent' | 'temporary' | 'unknown'
  readonly confidence: string; // 'authoritative' | 'none'
  readonly reason?: string | null;
  readonly observedAt: string;
}

export interface CreateObservationInput {
  readonly watchlistId: number;
  readonly network: string;
  readonly currentLedger: number;
  readonly liveUntilLedgerSeq?: number | null;
  readonly remainingLedgers?: number | null;
  readonly lastModifiedLedgerSeq?: number | null;
  readonly status: string;
  readonly durability: string;
  readonly confidence: string;
  readonly reason?: string | null;
}

export type AlertCategory =
  "low_ttl" | "ttl_reached" | "unknown_status" | "rpc_failure" | "config_failure";

export type AlertDeliveryStatus = "pending" | "delivered" | "failed";

export interface AlertRecord {
  readonly id: number;
  readonly watchlistId?: number | null;
  readonly network: string;
  readonly category: AlertCategory;
  readonly title: string;
  readonly message: string;
  readonly payloadJson?: string | null;
  readonly createdAt: string;
  readonly delivered: boolean;
  readonly deliveryStatus?: AlertDeliveryStatus;
  readonly deliveryAttempts?: number;
  readonly lastDeliveryError?: string | null;
  readonly deliveredAt?: string | null;
}

export interface CreateAlertInput {
  readonly watchlistId?: number | null;
  readonly network: string;
  readonly category: AlertCategory;
  readonly title: string;
  readonly message: string;
  readonly payloadJson?: string | null;
}

export interface MonitoringCycleSummary {
  readonly cycleId: string;
  readonly network: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly totalKeys: number;
  readonly liveKeys: number;
  readonly ttlReachedKeys: number;
  readonly unknownKeys: number;
  readonly errorKeys: number;
  readonly alertsTriggered: number;
}

export interface ReconstructedKey {
  readonly key: xdr.LedgerKey;
  readonly keyXdr: string;
  readonly keyType: WatchlistKeyType;
}
