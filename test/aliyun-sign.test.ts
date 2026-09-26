// 阿里云签名编码单测：percentEncode 语义 + sign() 与 Node crypto 的交叉验证
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { percentEncode, sign } from '../src/provider/aliyun';

describe('percentEncode（RFC 3986）', () => {
  it('字面 + 编码为 %2B（曾误替换为 %20 导致 SignatureDoesNotMatch）', () => {
    expect(percentEncode('a+b')).toBe('a%2Bb');
  });

  it('空格编码为 %20', () => {
    expect(percentEncode('a b')).toBe('a%20b');
  });

  it('波浪号保留、星号按阿里云规范保留为 *', () => {
    expect(percentEncode('~')).toBe('~');
    expect(percentEncode('a*b')).toBe('a*b');
  });

  it('综合用例', () => {
    expect(percentEncode('a+b c~d*e')).toBe('a%2Bb%20c~d*e');
    expect(percentEncode('2026-09-26T12:00:00Z')).toBe('2026-09-26T12%3A00%3A00Z');
    expect(percentEncode('cn-hangzhou')).toBe('cn-hangzhou');
  });
});

describe('sign()（HMAC-SHA1 RPC 签名）', () => {
  // 用 Node 原生 crypto 独立实现同一算法，交叉验证 Web Crypto 路径的正确性
  function referenceSign(params: Record<string, string>, secret: string): string {
    const keys = Object.keys(params).filter((k) => k !== 'Signature').sort();
    const canonical = keys.map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
    const stringToSign = `POST&%2F&${percentEncode(canonical)}`;
    return createHmac('sha1', secret + '&').update(stringToSign).digest('base64');
  }

  it('与 Node crypto 的 HMAC-SHA1 实现一致（参数不含特殊字符）', async () => {
    const params = {
      AccessKeyId: 'LTAI5tFake',
      Action: 'DescribeInstanceStatus',
      Format: 'JSON',
      RegionId: 'cn-hangzhou',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: '0123456789abcdef',
      SignatureVersion: '1.0',
      Timestamp: '2026-09-26T12:00:00Z',
      Version: '2014-05-26',
    };
    const expected = referenceSign(params, 'secretKey');
    expect(await sign(params, 'secretKey')).toBe(expected);
  });

  it('参数含 + / 空格 / ~ / * 时与参考实现一致', async () => {
    const params = {
      Action: 'StopInstance',
      InstanceId: 'i-plus+plus space',
      RegionId: 'cn-hongkong',
      StoppedMode: 'StopCharging',
      Remark: 'a~b*c',
    };
    const expected = referenceSign(params, 'sec&ret');
    expect(await sign(params, 'sec&ret')).toBe(expected);
  });

  it('Signature 字段不参与签名、键序与取值影响结果', async () => {
    const base = { Action: 'StartInstance', RegionId: 'cn-beijing' };
    const withSig = { ...base, Signature: 'IGNORED' };
    expect(await sign(base, 'k')).toBe(await sign(withSig, 'k'));
    expect(await sign(base, 'k')).not.toBe(await sign({ ...base, RegionId: 'cn-shanghai' }, 'k'));
  });
});
