// DNS 厂商注册表：新增厂商只需在这里 import 并登记
//
// 上层（sync / API / 前端）一律通过本文件访问厂商，不直接 import 具体 provider，
// 这样加厂商不用改业务代码。

import type { DnsProvider, DnsProviderMeta } from './types';
import { cloudflareProvider } from './cloudflare';
import { aliyunProvider } from './aliyun';
import { dnspodProvider } from './dnspod';
import { nameComProvider } from './namecom';
import { spaceshipProvider } from './spaceship';
import { godaddyProvider } from './godaddy';

const REGISTRY: DnsProvider[] = [
  cloudflareProvider,
  aliyunProvider,
  dnspodProvider,
  nameComProvider,
  spaceshipProvider,
  godaddyProvider,
];

const BY_ID = new Map<string, DnsProvider>(REGISTRY.map((p) => [p.meta.id, p]));

/** 按 id 取厂商；未知返回 null（调用方负责提示） */
export function getProvider(id: string): DnsProvider | null {
  return BY_ID.get(String(id || '').trim().toLowerCase()) || null;
}

/** 所有厂商的元信息（前端用它动态渲染凭据表单，加厂商无需改前端） */
export function listProviders(): DnsProviderMeta[] {
  return REGISTRY.map((p) => p.meta);
}

export type { DnsProvider, DnsProviderMeta, DnsTarget, QueryResult } from './types';
