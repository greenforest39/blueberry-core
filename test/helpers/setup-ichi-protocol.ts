import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumber, utils, Contract } from 'ethers';
import { ethers, upgrades } from 'hardhat';
import { ichiStrategies, IchiStrategy } from '../helpers/strategy-registry/ichiStrategies';
import {
  BlueberryBank,
  CoreOracle,
  IchiSpell,
  IWETH,
  MockOracle,
  SoftVault,
  IchiVaultOracle,
  WERC20,
  WIchiFarm,
  ProtocolConfig,
  MockIchiVault,
  MockIchiFarm,
  ERC20,
  IUniswapV2Router02,
  MockIchiV2,
  HardVault,
  FeeManager,
  UniV3WrappedLib,
  Comptroller,
  BToken,
  BErc20Delegator,
  IBank,
  MockIchiVault__factory,
} from '../../typechain-types';
import { ADDRESS, CONTRACT_NAMES } from '../../constant';
import { deployBTokens } from './money-market';
import { deploySoftVaults } from './markets';
import { faucetToken } from './paraswap';
import { token } from '../../typechain-types/@openzeppelin/contracts';
import { strategies } from '../spell/strategies/aura/aura.test';

/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable prefer-const */
const WETH = ADDRESS.WETH;
const wstETH = ADDRESS.wstETH;
const USDC = ADDRESS.USDC;
const DAI = ADDRESS.DAI;
const ICHI = ADDRESS.ICHI;
const WBTC = ADDRESS.WBTC;
const ALCX = ADDRESS.ALCX;
const ICHIV1 = ADDRESS.ICHI_FARM;
const UNI_V3_ROUTER = ADDRESS.UNI_V3_ROUTER;
const ETH_PRICE = 1600;

export interface Protocol {
  ichiStrategies: IchiStrategy[];
  ichiFarm: MockIchiFarm;
  werc20: WERC20;
  wichi: WIchiFarm;
  mockOracle: MockOracle;
  ichiOracle: IchiVaultOracle;
  oracle: CoreOracle;
  config: ProtocolConfig;
  bank: BlueberryBank;
  ichiSpell: IchiSpell;
  feeManager: FeeManager;
  uniV3Lib: UniV3WrappedLib;
  hardVault: HardVault;
  softVaults: SoftVault[];
  bTokens: BErc20Delegator[];
}

const addStrategies = async (
  vaultFactory: MockIchiVault__factory,
  spell: IchiSpell,
  ichiFarm: MockIchiFarm,
  admin: SignerWithAddress
): Promise<IchiStrategy[]> => {
  for (let i = 0; i < ichiStrategies.length; i++) {
    let vault = <MockIchiVault>(
      await vaultFactory.deploy(ichiStrategies[i].poolAddress, true, true, admin.address, admin.address, 3600)
    );
    await vault.deployed();

    let token0 = <ERC20>await ethers.getContractAt('ERC20', await vault.token0());
    let token0Decimals = await token0.decimals();
    let token1 = <ERC20>await ethers.getContractAt('ERC20', await vault.token1());
    let token1Decimals = await token1.decimals();

    await token0.approve(vault.address, utils.parseUnits('1000', token0Decimals));
    await token1.approve(vault.address, utils.parseUnits('1000', token1Decimals));

    let token0Amount = utils.parseUnits('1000', token0Decimals);
    let token1Amount = utils.parseUnits('1000', token1Decimals);

    await vault.deposit(token0Amount, token1Amount, admin.address);

    await ichiFarm.add(100, vault.address);

    await spell.addStrategy(vault.address, ichiStrategies[i].minPosition, ichiStrategies[i].maxPosition);
    await spell.setCollateralsMaxLTVs(0, ichiStrategies[i].collTokens, ichiStrategies[i].maxLTVs);
  }

  return ichiStrategies;
};

export const setupIchiProtocol = async (): Promise<Protocol> => {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let treasury: SignerWithAddress;

  let usdc: ERC20;
  let dai: ERC20;
  let ichi: MockIchiV2;
  let ichiV1: ERC20;
  let weth: IWETH;
  let wbtc: ERC20;
  let alcx: ERC20;
  let werc20: WERC20;
  let wichi: WIchiFarm;
  let mockOracle: MockOracle;
  let ichiOracle: IchiVaultOracle;
  let oracle: CoreOracle;
  let ichiSpell: IchiSpell;

  let config: ProtocolConfig;
  let feeManager: FeeManager;
  let bank: BlueberryBank;
  let ichiFarm: MockIchiFarm;
  let ichi_USDC_ICHI_Vault: MockIchiVault;
  let ichi_USDC_DAI_Vault: MockIchiVault;

  let comptroller: Comptroller;

  let bUSDC: Contract;
  let bICHI: Contract;
  let bCRV: Contract;
  let bDAI: Contract;
  let bMIM: Contract;
  let bLINK: Contract;
  let bOHM: Contract;
  let bSUSHI: Contract;
  let bBAL: Contract;
  //let bALCX: Contract;
  let bWETH: Contract;
  let bWBTC: Contract;
  let bTokenAdmin: Contract;

  [admin, alice, treasury] = await ethers.getSigners();
  usdc = <ERC20>await ethers.getContractAt('ERC20', USDC);
  dai = <ERC20>await ethers.getContractAt('ERC20', DAI);
  ichi = <MockIchiV2>await ethers.getContractAt('MockIchiV2', ICHI);
  ichiV1 = <ERC20>await ethers.getContractAt('ERC20', ICHIV1);
  weth = <IWETH>await ethers.getContractAt(CONTRACT_NAMES.IWETH, WETH);
  wbtc = <ERC20>await ethers.getContractAt('ERC20', ADDRESS.WBTC);

  // Mint tokens to admin
  await faucetToken(DAI, utils.parseUnits('100000'), admin, 100);
  await faucetToken(WETH, utils.parseUnits('100000'), admin, 100);
  await faucetToken(USDC, utils.parseUnits('100000', 6), admin, 100);
  await faucetToken(wstETH, utils.parseUnits('100000'), admin, 100);
  await faucetToken(WBTC, utils.parseUnits('100000', 8), admin, 100);
  await weth.approve(ADDRESS.SUSHI_ROUTER, ethers.constants.MaxUint256);
  // Get IchiV1 tokens from the sudhi router
  const sushiRouter = <IUniswapV2Router02>(
    await ethers.getContractAt(CONTRACT_NAMES.IUniswapV2Router02, ADDRESS.SUSHI_ROUTER)
  );

  await sushiRouter.swapExactTokensForTokens(
    utils.parseUnits('40'),
    0,
    [WETH, ICHIV1],
    admin.address,
    ethers.constants.MaxUint256
  );

  await ichiV1.approve(ICHI, ethers.constants.MaxUint256);
  const ichiV1Balance = await ichiV1.balanceOf(admin.address);

  await ichi.convertToV2(ichiV1Balance.div(2));

  await sushiRouter.swapExactTokensForTokens(
    utils.parseUnits('1000'),
    0,
    [WETH, ADDRESS.ALCX],
    admin.address,
    ethers.constants.MaxUint256
  );

  // *************** Deploy ICHI Integration ***************
  const LinkedLibFactory = await ethers.getContractFactory('UniV3WrappedLib');
  const LibInstance = await LinkedLibFactory.deploy();

  const IchiVault = await ethers.getContractFactory('MockIchiVault', {
    libraries: {
      UniV3WrappedLibContainer: LibInstance.address,
    },
  });

  const MockOracle = await ethers.getContractFactory(CONTRACT_NAMES.MockOracle);
  mockOracle = <MockOracle>await MockOracle.deploy();
  await mockOracle.deployed();
  await mockOracle.setPrice(
    [WETH, USDC, ICHI, DAI, wstETH, WBTC, ALCX],
    [
      BigNumber.from(10).pow(18).mul(ETH_PRICE),
      BigNumber.from(10).pow(18), // $1
      BigNumber.from(10).pow(18).mul(5), // $5
      BigNumber.from(10).pow(18), // $1
      BigNumber.from(10).pow(18).mul(ETH_PRICE),
      BigNumber.from(10).pow(18).mul(50000), // $50,000
      BigNumber.from(10).pow(18).mul(20), // $20
    ]
  );

  const IchiVaultOracle = await ethers.getContractFactory(CONTRACT_NAMES.IchiVaultOracle, {
    libraries: {
      UniV3WrappedLibContainer: LibInstance.address,
    },
  });
  ichiOracle = <IchiVaultOracle>await upgrades.deployProxy(IchiVaultOracle, [mockOracle.address, admin.address], {
    unsafeAllow: ['delegatecall', 'external-library-linking'],
  });

  await ichiOracle.deployed();
  await ichiOracle.setPriceDeviation(ICHI, 500);
  await ichiOracle.setPriceDeviation(USDC, 500);
  await ichiOracle.setPriceDeviation(DAI, 500);
  await ichiOracle.setPriceDeviation(wstETH, 500);
  await ichiOracle.setPriceDeviation(WBTC, 500);
  await ichiOracle.setPriceDeviation(ALCX, 500);

  const CoreOracle = await ethers.getContractFactory(CONTRACT_NAMES.CoreOracle);
  oracle = <CoreOracle>await upgrades.deployProxy(CoreOracle, [admin.address], { unsafeAllow: ['delegatecall'] });
  await oracle.deployed();

  await oracle.setRoutes(
    [WETH, USDC, ICHI, DAI, wstETH, WBTC, ALCX],
    [
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
    ]
  );

  // Deploy Bank
  const Config = await ethers.getContractFactory('ProtocolConfig');
  config = <ProtocolConfig>await upgrades.deployProxy(Config, [treasury.address, admin.address], {
    unsafeAllow: ['delegatecall'],
  });
  await config.deployed();

  const FeeManager = await ethers.getContractFactory('FeeManager');
  feeManager = <FeeManager>await upgrades.deployProxy(FeeManager, [config.address, admin.address], {
    unsafeAllow: ['delegatecall'],
  });
  await feeManager.deployed();
  await config.setFeeManager(feeManager.address);

  const BlueberryBank = await ethers.getContractFactory(CONTRACT_NAMES.BlueberryBank);

  bank = <BlueberryBank>await upgrades.deployProxy(BlueberryBank, [oracle.address, config.address, admin.address], {
    unsafeAllow: ['delegatecall'],
  });
  await bank.deployed();

  // Deploy ICHI wrapper
  const MockIchiFarm = await ethers.getContractFactory('MockIchiFarm');
  ichiFarm = <MockIchiFarm>await MockIchiFarm.deploy(
    ADDRESS.ICHI_FARM,
    ethers.utils.parseUnits('1', 9) // 1 ICHI.FARM per block
  );

  const WERC20 = await ethers.getContractFactory(CONTRACT_NAMES.WERC20);
  werc20 = <WERC20>await upgrades.deployProxy(WERC20, [admin.address], { unsafeAllow: ['delegatecall'] });
  await werc20.deployed();

  const WIchiFarm = await ethers.getContractFactory(CONTRACT_NAMES.WIchiFarm);
  wichi = <WIchiFarm>await upgrades.deployProxy(
    WIchiFarm,
    [ADDRESS.ICHI, ADDRESS.ICHI_FARM, ichiFarm.address, admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );
  await wichi.deployed();

  // Deploy ICHI spell
  const IchiSpell = await ethers.getContractFactory(CONTRACT_NAMES.IchiSpell);
  ichiSpell = <IchiSpell>(
    await upgrades.deployProxy(
      IchiSpell,
      [
        bank.address,
        werc20.address,
        WETH,
        wichi.address,
        UNI_V3_ROUTER,
        ADDRESS.AUGUSTUS_SWAPPER,
        ADDRESS.TOKEN_TRANSFER_PROXY,
        admin.address,
      ],
      { unsafeAllow: ['delegatecall'] }
    )
  );
  await ichiSpell.deployed();

  const strats: IchiStrategy[] = await addStrategies(IchiVault, ichiSpell, ichiFarm, admin);
  console.log('strats', strats.length);
  // Register Ichi Vaults within the core oracle
  for (let i = 0; i < strats.length; i++) {
    await ichiOracle.registerVault(strats[i].vaultAddress);
    await oracle.setRoutes([strats[i].vaultAddress], [ichiOracle.address]);
  }

  // Setup Bank
  await bank.whitelistSpells([ichiSpell.address], [true]);
  await bank.whitelistTokens(
    [USDC, DAI, wstETH, WETH, ADDRESS.ALCX, ADDRESS.WBTC, ADDRESS.ALCX],
    [true, true, true, true, true, true, true]
  );
  await bank.whitelistERC1155([werc20.address, wichi.address], true);

  const bTokens = await deployBTokens(admin.address);
  comptroller = bTokens.comptroller;

  bUSDC = bTokens.bUSDC;
  bICHI = bTokens.bICHI;
  bCRV = bTokens.bCRV;
  bDAI = bTokens.bDAI;
  bMIM = bTokens.bMIM;
  bLINK = bTokens.bLINK;
  bBAL = bTokens.bBAL;
  //bALCX = bTokens.bALCX;
  bWETH = bTokens.bWETH;
  bWBTC = bTokens.bWBTC;
  bTokenAdmin = bTokens.bTokenAdmin;

  const HardVault = await ethers.getContractFactory(CONTRACT_NAMES.HardVault);
  hardVault = <HardVault>await upgrades.deployProxy(HardVault, [config.address, admin.address], {
    unsafeAllow: ['delegatecall'],
  });

  const SoftVault = await ethers.getContractFactory(CONTRACT_NAMES.SoftVault);
  usdcSoftVault = <SoftVault>await upgrades.deployProxy(
    SoftVault,
    [config.address, bUSDC.address, 'Interest Bearing USDC', 'ibUSDC', admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );
  await usdcSoftVault.deployed();
  await bank.addBank(USDC, usdcSoftVault.address, hardVault.address, 9000);
  await bTokenAdmin._setSoftVault(bUSDC.address, usdcSoftVault.address);

  daiSoftVault = <SoftVault>await upgrades.deployProxy(
    SoftVault,
    [config.address, bDAI.address, 'Interest Bearing DAI', 'ibDAI', admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );
  await daiSoftVault.deployed();
  await bank.addBank(DAI, daiSoftVault.address, hardVault.address, 8500);
  await bTokenAdmin._setSoftVault(bDAI.address, daiSoftVault.address);

  ichiSoftVault = <SoftVault>await upgrades.deployProxy(
    SoftVault,
    [config.address, bICHI.address, 'Interest Bearing ICHI', 'ibICHI', admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );
  await ichiSoftVault.deployed();
  await bank.addBank(ICHI, ichiSoftVault.address, hardVault.address, 9000);
  await bTokenAdmin._setSoftVault(bICHI.address, ichiSoftVault.address);

  wethSoftVault = <SoftVault>await upgrades.deployProxy(
    SoftVault,
    [config.address, bWETH.address, 'Interest Bearing WETH', 'ibWETH', admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );
  await wethSoftVault.deployed();

  const softVaults = await deploySoftVaults(config, bank, comptroller, bTokens.bTokens, admin, alice);
  const bankInfo = <IBank.BankStructOutput>await bank.getBankInfo(USDC);

  const hardVault = <HardVault>await ethers.getContractAt('HardVault', bankInfo.hardVault);

  return {
    ichiStrategies: strats,
    ichiFarm,
    werc20,
    wichi,
    mockOracle,
    ichiOracle,
    oracle,
    config,
    feeManager,
    bank,
    ichiSpell,
    uniV3Lib: LibInstance,
    hardVault,
    softVaults,
    bTokens: bTokens.bTokens,
  };
};
