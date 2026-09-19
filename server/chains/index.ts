import {
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  zeroAddress,
  zeroHash,
} from 'viem';
import type { Address, Hex } from 'viem';
import { FLAP_ABI, FLAP_PORTAL, PONS_ABI, PONS_FACTORY, PONS_ESCROW } from './abi.ts';
import {
  EvmExecution,
  assertAddress,
  equalAddress,
  EIP1967_IMPLEMENTATION_SLOT,
  fingerprint,
} from './execution.ts';
import type { AdapterConfig, ChainReceipt, TransactionIntent } from './execution.ts';
export * from './abi.ts';
export * from './execution.ts';
export { createVaultEvmSigner } from './signer.ts';
export { FileExecutionJournal, SqliteExecutionJournal } from './journal.ts';
export { createHttpChainRpc } from './rpc.ts';

function metadata(name: string, symbol: string) {
  if (!name.trim() || name.length > 100 || !/^[A-Za-z0-9]{1,12}$/.test(symbol))
    throw new Error('Invalid launch metadata');
}
function base(
  config: AdapterConfig,
  chainId: 56 | 4663,
  id: string,
  kind: 'launch' | 'claim',
  to: Address,
  data: Hex,
  value = 0n,
): TransactionIntent {
  return {
    id,
    chainId,
    kind,
    account: config.signer.address,
    to,
    data,
    value,
    feeRecipient: config.feeRecipient,
  };
}
function events(receipt: ChainReceipt, address: Address, abi: typeof FLAP_ABI | typeof PONS_ABI) {
  return receipt.logs
    .filter((log) => equalAddress(log.address, address))
    .flatMap((log) => {
      try {
        return [
          {
            ...decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true }),
            logIndex: log.logIndex,
          },
        ];
      } catch {
        return [];
      }
    });
}
export interface FlapLaunch {
  name: string;
  symbol: string;
  meta: string;
  salt: Hex;
  quoteAmountWei: bigint;
}
/** Standard permit-token V6 rev-share flow. Tax-token launches require a separate reviewed policy. */
export function createFlapAdapter(config: AdapterConfig) {
  const engine = new EvmExecution(56, config, (intent) => {
    if (!equalAddress(intent.to, FLAP_PORTAL)) throw new Error('Unapproved Flap destination');
    const decoded = decodeFunctionData({ abi: FLAP_ABI, data: intent.data });
    if (intent.kind === 'launch' && decoded.functionName === 'newTokenV6') {
      const p = decoded.args[0];
      metadata(p.name, p.symbol);
      if (!equalAddress(p.beneficiary, config.feeRecipient))
        throw new Error('Flap fee recipient mismatch');
      if (
        p.tokenVersion !== 2 ||
        p.quoteToken !== zeroAddress ||
        p.quoteAmt !== intent.value ||
        p.buyTaxRate !== 0 ||
        p.sellTaxRate !== 0 ||
        p.taxDuration !== 0n ||
        p.antiFarmerDuration !== 0n ||
        p.mktBps !== 0 ||
        p.deflationBps !== 0 ||
        p.dividendBps !== 0 ||
        p.lpBps !== 0 ||
        p.minimumShareBalance !== 0n ||
        p.dividendToken !== zeroAddress ||
        p.commissionReceiver !== zeroAddress ||
        p.permitData !== '0x' ||
        p.extensionID !== zeroHash ||
        p.extensionData !== '0x' ||
        p.dexThresh !== 0 ||
        p.migratorType !== 0 ||
        p.dexId !== 0 ||
        p.lpFeeProfile !== 0
      )
        throw new Error('Flap launch calldata exceeds policy');
    } else if (intent.kind === 'claim' && decoded.functionName === 'claim') {
      if (intent.value !== 0n || !intent.token || !equalAddress(decoded.args[0], intent.token))
        throw new Error('Flap claim token mismatch');
    } else throw new Error('Unapproved Flap function');
  });
  async function verifyDeployment() {
    if (
      !config.storagePins?.some(
        (pin) => equalAddress(pin.address, FLAP_PORTAL) && pin.slot === EIP1967_IMPLEMENTATION_SLOT,
      )
    )
      throw new Error('Flap implementation storage pin is required');
    await engine.verifyNetwork([FLAP_PORTAL]);
  }
  async function verifyClaim(intent: TransactionIntent) {
    await verifyDeployment();
    if (intent.kind === 'claim') {
      const binding = await config.journal.get(`token:56:${intent.token?.toLowerCase()}`);
      if (
        !binding?.tokenBinding?.nativeQuote ||
        !equalAddress(binding.tokenBinding.feeRecipient, config.feeRecipient)
      )
        throw new Error('Flap claim requires a verified native launch');
    }
  }
  return {
    chainId: 56 as const,
    platform: 'flap' as const,
    async buildLaunch(id: string, input: FlapLaunch) {
      metadata(input.name, input.symbol);
      if (!input.meta || input.meta.length > 256)
        throw new Error('Pinned Flap metadata CID required');
      await verifyDeployment();
      const data = encodeFunctionData({
        abi: FLAP_ABI,
        functionName: 'newTokenV6',
        args: [
          {
            name: input.name,
            symbol: input.symbol,
            meta: input.meta,
            salt: input.salt,
            dexThresh: 0,
            migratorType: 0,
            quoteToken: zeroAddress,
            quoteAmt: input.quoteAmountWei,
            beneficiary: config.feeRecipient,
            permitData: '0x',
            extensionID: zeroHash,
            extensionData: '0x',
            dexId: 0,
            lpFeeProfile: 0,
            buyTaxRate: 0,
            sellTaxRate: 0,
            taxDuration: 0n,
            antiFarmerDuration: 0n,
            mktBps: 0,
            deflationBps: 0,
            dividendBps: 0,
            lpBps: 0,
            minimumShareBalance: 0n,
            dividendToken: zeroAddress,
            commissionReceiver: zeroAddress,
            tokenVersion: 2,
          },
        ],
      });
      const intent = base(config, 56, id, 'launch', FLAP_PORTAL, data, input.quoteAmountWei);
      engine.assertIntent(intent);
      return intent;
    },
    async buildClaim(id: string, token: Address) {
      assertAddress(token);
      await verifyDeployment();
      const intent = {
        ...base(
          config,
          56,
          id,
          'claim',
          FLAP_PORTAL,
          encodeFunctionData({ abi: FLAP_ABI, functionName: 'claim', args: [token] }),
        ),
        token,
      };
      engine.assertIntent(intent);
      await verifyClaim(intent);
      return intent;
    },
    async claimableNative(token: Address) {
      assertAddress(token);
      const intent = {
        ...base(
          config,
          56,
          'claim-probe',
          'claim',
          FLAP_PORTAL,
          encodeFunctionData({ abi: FLAP_ABI, functionName: 'claim', args: [token] }),
        ),
        token,
      };
      await verifyClaim(intent);
      const result = (await config.rpc.request('eth_call', [
        { from: config.signer.address, to: FLAP_PORTAL, data: intent.data },
        'latest',
      ])) as Hex;
      const [, nativeAmount] = decodeFunctionResult({
        abi: FLAP_ABI,
        functionName: 'claim',
        data: result,
      });
      return nativeAmount;
    },
    async simulate(intent: TransactionIntent) {
      await verifyClaim(intent);
      return engine.simulate(intent);
    },
    async execute(intent: TransactionIntent) {
      await verifyClaim(intent);
      return engine.execute(intent);
    },
    async rebroadcast(intent: TransactionIntent) {
      await verifyClaim(intent);
      return engine.rebroadcast(intent);
    },
    async reconcile(intent: TransactionIntent) {
      await verifyClaim(intent);
      const { result, receipt } = await engine.receipt(intent);
      if (!receipt) return result;
      const matches = events(receipt, FLAP_PORTAL, FLAP_ABI).filter(
        (e) =>
          e.eventName === (intent.kind === 'launch' ? 'VanityTokenCreated' : 'BeneficiaryClaimed'),
      );
      if (matches.length !== 1) throw new Error('Missing or ambiguous Flap event');
      const event = matches[0];
      const args = event.args as {
        token: Address;
        creator?: Address;
        beneficiary: Address;
        ethAmount?: bigint;
        tokenAmount?: bigint;
      };
      assertAddress(args.token);
      if (!equalAddress(args.beneficiary, config.feeRecipient))
        throw new Error('Flap event fee recipient mismatch');
      if (
        intent.kind === 'launch' &&
        (!args.creator || !equalAddress(args.creator, intent.account))
      )
        throw new Error('Flap event creator mismatch');
      if (intent.kind === 'claim' && (!intent.token || !equalAddress(args.token, intent.token)))
        throw new Error('Flap event token mismatch');
      if (intent.kind === 'launch')
        await config.journal.put(`token:56:${args.token.toLowerCase()}`, {
          fingerprint: fingerprint(intent),
          status: 'signed',
          hash: result.hash,
          tokenBinding: {
            token: args.token,
            feeRecipient: config.feeRecipient,
            launchHash: result.hash,
            nativeQuote: true,
          },
        });
      return {
        ...result,
        token: args.token,
        feeAmountWei: args.ethAmount,
        feeTokenAmount: args.tokenAmount,
        evidenceId: `56:${result.hash}:${event.logIndex}`,
      };
    },
  };
}
export interface PonsLaunch {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  salt: Hex;
  launchConfigId: bigint;
}
export function createPonsAdapter(config: AdapterConfig) {
  const engine = new EvmExecution(4663, config, (intent) => {
    const d = decodeFunctionData({ abi: PONS_ABI, data: intent.data });
    if (
      intent.kind === 'launch' &&
      d.functionName === 'launchToken' &&
      equalAddress(intent.to, PONS_FACTORY)
    ) {
      const p = d.args[0];
      metadata(p.name, p.symbol);
      if (!equalAddress(p.creatorFeeRecipient, config.feeRecipient))
        throw new Error('PONs fee recipient mismatch');
      if (
        d.args[2] !== zeroAddress ||
        p.creatorTaxBps !== 0 ||
        p.buybackEnabled ||
        p.expectedEconomics === zeroHash
      )
        throw new Error('PONs launch calldata exceeds policy');
    } else if (!(
      intent.kind === 'claim' &&
      d.functionName === 'claim' &&
      equalAddress(intent.to, PONS_ESCROW) &&
      intent.value === 0n
    ))
      throw new Error('Unapproved PONs function or destination');
  });
  async function read(data: Hex, block = 'latest', address: Address = PONS_FACTORY) {
    return (await config.rpc.request('eth_call', [{ to: address, data }, block])) as Hex;
  }
  return {
    chainId: 4663 as const,
    platform: 'pons' as const,
    async buildLaunch(id: string, input: PonsLaunch) {
      metadata(input.name, input.symbol);
      await engine.verifyNetwork([PONS_FACTORY, PONS_ESCROW]);
      const gateData = encodeFunctionData({
        abi: PONS_ABI,
        functionName: 'canLaunch',
        args: [config.signer.address],
      });
      const allowed = decodeFunctionResult({
        abi: PONS_ABI,
        functionName: 'canLaunch',
        data: await read(gateData),
      });
      if (!allowed) throw new Error('PONs launch gate closed for signer');
      const economicsData = encodeFunctionData({
        abi: PONS_ABI,
        functionName: 'previewLaunchEconomics',
        args: [input.launchConfigId, zeroAddress],
      });
      const feeData = encodeFunctionData({ abi: PONS_ABI, functionName: 'launchFee' });
      const [economicsResult, feeResult] = await Promise.all([read(economicsData), read(feeData)]);
      const expectedEconomics = decodeFunctionResult({
        abi: PONS_ABI,
        functionName: 'previewLaunchEconomics',
        data: economicsResult,
      });
      const fee = decodeFunctionResult({
        abi: PONS_ABI,
        functionName: 'launchFee',
        data: feeResult,
      });
      const data = encodeFunctionData({
        abi: PONS_ABI,
        functionName: 'launchToken',
        args: [
          {
            name: input.name,
            symbol: input.symbol,
            logo: input.logo,
            description: input.description,
            socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
            creatorFeeRecipient: config.feeRecipient,
            creatorTaxBps: 0,
            buybackEnabled: false,
            expectedEconomics,
            salt: input.salt,
          },
          input.launchConfigId,
          zeroAddress,
        ],
      });
      const intent = base(config, 4663, id, 'launch', PONS_FACTORY, data, fee);
      engine.assertIntent(intent);
      return intent;
    },
    async buildClaim(id: string) {
      await engine.verifyNetwork([PONS_ESCROW]);
      return base(
        config,
        4663,
        id,
        'claim',
        PONS_ESCROW,
        encodeFunctionData({ abi: PONS_ABI, functionName: 'claim' }),
      );
    },
    async claimableNative() {
      await engine.verifyNetwork([PONS_ESCROW]);
      return decodeFunctionResult({
        abi: PONS_ABI,
        functionName: 'balanceOf',
        data: await read(
          encodeFunctionData({
            abi: PONS_ABI,
            functionName: 'balanceOf',
            args: [config.feeRecipient],
          }),
          'latest',
          PONS_ESCROW,
        ),
      });
    },
    simulate: engine.simulate.bind(engine),
    execute: engine.execute.bind(engine),
    rebroadcast: engine.rebroadcast.bind(engine),
    async reconcile(intent: TransactionIntent) {
      const { result, receipt } = await engine.receipt(intent);
      if (!receipt) return result;
      // Published docs name Claimed but omit its field/index ABI. Never fabricate an amount.
      if (intent.kind === 'claim') return { ...result, requiresPayoutEvidence: true };
      const matches = events(receipt, PONS_FACTORY, PONS_ABI).filter(
        (e) => e.eventName === 'TokenLaunched',
      );
      if (matches.length !== 1) throw new Error('Missing or ambiguous PONs launch event');
      const event = matches[0];
      const args = event.args as {
        token: Address;
        curve: Address;
        deployer: Address;
        pairToken: Address;
        launchConfigId: bigint;
      };
      const d = decodeFunctionData({ abi: PONS_ABI, data: intent.data });
      if (
        d.functionName !== 'launchToken' ||
        !equalAddress(args.deployer, intent.account) ||
        args.pairToken !== zeroAddress ||
        args.launchConfigId !== d.args[1]
      )
        throw new Error('PONs launch event identity mismatch');
      const launched = decodeFunctionResult({
        abi: PONS_ABI,
        functionName: 'getLaunchedToken',
        data: await read(
          encodeFunctionData({
            abi: PONS_ABI,
            functionName: 'getLaunchedToken',
            args: [args.token],
          }),
          receipt.blockNumber,
        ),
      });
      if (
        !launched.exists ||
        !equalAddress(launched.token, args.token) ||
        !equalAddress(launched.curve, args.curve) ||
        !equalAddress(launched.deployer, intent.account) ||
        launched.pairToken !== zeroAddress
      )
        throw new Error('PONs launch state identity mismatch');
      if (!equalAddress(launched.creatorFeeRecipient, config.feeRecipient))
        throw new Error('PONs on-chain fee recipient mismatch');
      return { ...result, token: args.token, evidenceId: `4663:${result.hash}:${event.logIndex}` };
    },
  };
}
export interface SettlementRoute {
  sourceChainId: number;
  sourceAsset: string;
  destinationChainId: number;
  destinationAsset: string;
  depositAddress: Address;
  mode: 'direct' | 'bridge';
  /** Authenticated exchange discovery, never inferred from the symbol ETH. */
  exchangeNetworkVerified?: boolean;
  bridgeAdapter?: {
    id: string;
    sourceChainId: number;
    sourceAsset: string;
    destinationChainId: number;
    destinationAsset: string;
  };
}
export function validateSettlementRoute(route: SettlementRoute) {
  assertAddress(route.depositAddress);
  if (
    route.mode === 'direct' &&
    (route.sourceChainId !== route.destinationChainId ||
      route.sourceAsset !== route.destinationAsset)
  )
    throw new Error('Direct deposit network or asset mismatch');
  if (route.mode === 'bridge') {
    const bridge = route.bridgeAdapter;
    if (
      !bridge?.id ||
      bridge.sourceChainId !== route.sourceChainId ||
      bridge.sourceAsset !== route.sourceAsset ||
      bridge.destinationChainId !== route.destinationChainId ||
      bridge.destinationAsset !== route.destinationAsset
    )
      throw new Error('Explicit compatible bridge adapter is required');
  }
  if (route.exchangeNetworkVerified !== true)
    throw new Error('Exchange deposit network must be verified by authenticated discovery');
  return route;
}
