import type { TestContext } from 'node:test';
import type { APIRequestContext, Page } from 'playwright';
import assert from 'node:assert/strict';

export function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, 'Expected fixture value to exist');
  return value;
}

export function objectValue(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), 'Expected fixture object');
  return value as Record<string, unknown>;
}

export function stringValue(value: unknown): string {
  assert.equal(typeof value, 'string', 'Expected fixture string');
  return value as string;
}

export function fixtureCollection(campaign: FixtureCampaign, name: string): FixtureCollection {
  return required(campaign.collections.find(collection => collection.name === name));
}

export function fixtureRecord<Value = Record<string, unknown>>(collection: FixtureCollection, key: string): FixtureRecord<Value> {
  return required(collection.records.find(record => record.key === key)) as FixtureRecord<Value>;
}

export interface FixtureRecord<Value = Record<string, unknown>> {
  key: string;
  revision: number;
  value: Value;
}

export interface FixtureCollection {
  name: string;
  shape: string;
  materialized: boolean;
  revision: number;
  records: FixtureRecord<unknown>[];
}

export interface FixtureCampaign {
  contractVersion: string;
  collections: FixtureCollection[];
}

export interface InstalledFixture {
  t: TestContext;
  open: (t: TestContext, role?: string, mobile?: boolean) => Promise<Page>;
  admin: APIRequestContext;
  csrf: string;
  output: string;
  mobile: boolean;
}

export interface FixturePermission {
  id: string;
  resources: string[];
  reason: string;
}

export interface FixtureMutation {
  operation: string;
  key: string;
  collection: string;
  dataId: string;
  expectedRevision: number;
  value: Record<string, unknown>;
}

export interface FixtureTransaction {
  contractVersion: string;
  mutations: FixtureMutation[];
  expectedDataSets: unknown[];
}
