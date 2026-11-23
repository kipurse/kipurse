// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
/// Kipurse V5.5 custom errors that do not exist in KipurseErrors.sol. Kept in a separate file so KipurseErrors.sol (imported by
/// the deployed V5.x contracts, part of their metadata hash) stays byte-for-byte unchanged.
error Registrar(); // V5.5 KR-03: registerPermission caller is neither the account nor the permission's executor
error VaultPermission(); // V5.5 KR-03: the vault is bound to a different permission than the one it tries to use
error TooManyReservations(); // V5.5 KR-02: more than PayerVaultV55.MAX_OPEN unsettled x402 reservations in one vault
error StaleProposal(); // V5.5 KR-04: the merchant was removed after this registry proposal was queued
error ProposalExpired(); // V5.5 KR-04: a matured registry proposal was not executed within its grace period
error RecordExpired(); // V5.5 KR-04: renew() on a registry record whose validity already ended
