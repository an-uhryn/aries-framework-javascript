import type { AgentConfig } from '../../src'

import { getAgentConfig } from '../../tests/helpers'

import { IndyWallet } from './IndyWallet'

describe('Wallet', () => {
  let wallet: IndyWallet
  let config: AgentConfig
  let configWithMasterSecretId: AgentConfig

  beforeEach(() => {
    config = getAgentConfig('WalletTest')
    configWithMasterSecretId = getAgentConfig('WalletTestWithMasterSecretId')
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    configWithMasterSecretId.walletConfig!.masterSecretId = 'main'
  })

  test('initialize public did', async () => {
    wallet = new IndyWallet(config)

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await wallet.createAndOpen(config.walletConfig!)

    await wallet.initPublicDid({ seed: '00000000000000000000000Forward01' })

    expect(wallet.publicDid).toEqual({
      did: 'DtWRdd6C5dN5vpcN6XRAvu',
      verkey: '82RBSn3heLgXzZd74UsMC8Q8YRfEEhQoAM7LUqE6bevJ',
    })
  })

  test('masterSecretId is equal to wallet ID by default', async () => {
    wallet = new IndyWallet(config)

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await wallet.createAndOpen(config.walletConfig!)

    expect(wallet.masterSecretId).toEqual(config.walletConfig!.id)
  })

  test('masterSecretId is set by config', async () => {
    wallet = new IndyWallet(configWithMasterSecretId)

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await wallet.createAndOpen(configWithMasterSecretId.walletConfig!)

    expect(wallet.masterSecretId).toEqual(configWithMasterSecretId.walletConfig!.masterSecretId)
  })

  afterEach(async () => {
    await wallet.delete()
  })
})
