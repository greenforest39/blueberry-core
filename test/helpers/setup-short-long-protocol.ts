import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumber, utils, Contract } from 'ethers';
import { ethers, upgrades } from 'hardhat';
import {
  BlueberryBank,
  CoreOracle,
  IWETH,
  MockOracle,
  SoftVault,
  WERC20,
  ProtocolConfig,
  ERC20,
  IUniswapV2Router02,
  HardVault,
  FeeManager,
  UniV3WrappedLib,
  CurveStableOracle,
  CurveVolatileOracle,
  CurveTricryptoOracle,
  SoftVaultOracle,
  ShortLongSpell,
  Comptroller,
} from '../../typechain-types';
import { ADDRESS, CONTRACT_NAMES } from '../../constant';
import { deployBTokens } from './money-market';
import { impersonateAccount } from '.';
import { deploySoftVaults } from './markets';
import { faucetToken } from './paraswap';
import { ShortLongStrategy, shortLongStrategies } from './strategy-registry/shortLongStrategies';

/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable prefer-const */

const AUGUSTUS_SWAPPER = ADDRESS.AUGUSTUS_SWAPPER;
const TOKEN_TRANSFER_PROXY = ADDRESS.TOKEN_TRANSFER_PROXY;
const WBTC = ADDRESS.WBTC;
const WETH = ADDRESS.WETH;
const WstETH = ADDRESS.wstETH;
const USDC = ADDRESS.USDC;
const USDT = ADDRESS.USDT;
const DAI = ADDRESS.DAI;
const FRAX = ADDRESS.FRAX;
const CRV = ADDRESS.CRV;
const AURA = ADDRESS.AURA;
const BAL = ADDRESS.BAL;
const LINK = ADDRESS.LINK;
const ETH_PRICE = 3200;
const BTC_PRICE = 60000;
const LINK_PRICE = 14;

export interface ShortLongProtocol {
  werc20: WERC20;
  mockOracle: MockOracle;
  softVaultOracle: SoftVaultOracle;
  oracle: CoreOracle;
  config: ProtocolConfig;
  bank: BlueberryBank;
  shortLongSpell: ShortLongSpell;
  feeManager: FeeManager;
  uniV3Lib: UniV3WrappedLib;
  strategies: ShortLongStrategy[];
  underlyingToSoftVault: Map<string, string>;
}

export const setupShortLongProtocol = async (): Promise<ShortLongProtocol> => {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let treasury: SignerWithAddress;

  let usdc: ERC20;
  let dai: ERC20;
  let crv: ERC20;
  let link: ERC20;
  let wbtc: ERC20;
  let weth: IWETH;
  let werc20: WERC20;
  let mockOracle: MockOracle;
  let softVaultOracle: SoftVaultOracle;
  let oracle: CoreOracle;
  let shortLongSpell: ShortLongSpell;

  let config: ProtocolConfig;
  let feeManager: FeeManager;
  let bank: BlueberryBank;
  let usdcSoftVault: SoftVault;
  let crvSoftVault: SoftVault;
  let daiSoftVault: SoftVault;
  let linkSoftVault: SoftVault;
  let wbtcSoftVault: SoftVault;
  let wethSoftVault: SoftVault;
  let wstETHSoftVault: SoftVault;
  let hardVault: HardVault;

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
  let bWstETH: Contract;
  let bTokenAdmin: Contract;

  const initialDeposit = utils.parseUnits('200');
  const initialSwapAmount = utils.parseUnits('10');

  const strategyDepositInUsd = '1000';
  const vaultLiquidityInUsd = '5000';

  [admin, alice, treasury] = await ethers.getSigners();
  usdc = <ERC20>await ethers.getContractAt('ERC20', USDC);
  dai = <ERC20>await ethers.getContractAt('ERC20', DAI);
  crv = <ERC20>await ethers.getContractAt('ERC20', CRV);
  link = <ERC20>await ethers.getContractAt('ERC20', LINK);
  wbtc = <ERC20>await ethers.getContractAt('ERC20', WBTC);
  weth = <IWETH>await ethers.getContractAt(CONTRACT_NAMES.IWETH, WETH);
  // Prepare USDC
  // deposit 200 eth -> 200 WETH
  await weth.deposit({ value: initialDeposit });

  // Transfer wstETH from whale
  const wstETHWhale = '0x5fEC2f34D80ED82370F733043B6A536d7e9D7f8d';
  const crvWhale = '0x6cC5F688a315f3dC28A7781717a9A798a59fDA7b';
  const daiWhale = '0x60FaAe176336dAb62e284Fe19B885B095d29fB7F';

  await admin.sendTransaction({
    to: wstETHWhale,
    value: utils.parseEther('10'),
  });

  await admin.sendTransaction({
    to: crvWhale,
    value: utils.parseEther('10'),
  });
  
  await impersonateAccount(wstETHWhale);
  const whale1 = await ethers.getSigner(wstETHWhale);
  const wstETH = <ERC20>await ethers.getContractAt('ERC20', WstETH);
  await wstETH.connect(whale1).transfer(admin.address, utils.parseUnits('100000'));

  await impersonateAccount(crvWhale);
  const whale2 = await ethers.getSigner(crvWhale);
  await crv.connect(whale2).transfer(admin.address, utils.parseUnits('100000'));

  await impersonateAccount(daiWhale);
  const whale3 = await ethers.getSigner(daiWhale);
  await dai.connect(whale3).transfer(admin.address, utils.parseUnits('100000'));

  await faucetToken(CRV, utils.parseUnits('100000'), admin, 100);
  await faucetToken(USDC, utils.parseUnits('100000', 6), admin, 100);
  await faucetToken(DAI, utils.parseUnits('100000'), admin, 100);
  await faucetToken(WETH, utils.parseUnits('100000'), admin, 100);
  await faucetToken(WBTC, utils.parseUnits('100000', 8), admin, 100);
  await faucetToken(LINK, utils.parseUnits('100000'), admin, 100);

  const LinkedLibFactory = await ethers.getContractFactory('UniV3WrappedLib');
  const LibInstance = await LinkedLibFactory.deploy();

  const MockOracle = await ethers.getContractFactory(CONTRACT_NAMES.MockOracle);
  mockOracle = <MockOracle>await MockOracle.deploy();
  await mockOracle.deployed();
  await mockOracle.setPrice(
    [WETH, WBTC, LINK, WstETH, USDC, CRV, DAI, USDT, FRAX, AURA, BAL, ADDRESS.BAL_UDU],
    [
      BigNumber.from(10).pow(18).mul(ETH_PRICE),
      BigNumber.from(10).pow(18).mul(BTC_PRICE),
      BigNumber.from(10).pow(18).mul(LINK_PRICE),
      BigNumber.from(10).pow(18).mul(ETH_PRICE),
      BigNumber.from(10).pow(18), // $1
      BigNumber.from(10).pow(18), // $1
      BigNumber.from(10).pow(18), // $1
      BigNumber.from(10).pow(18), // $1
      BigNumber.from(10).pow(18), // $1
      BigNumber.from(10).pow(18), // $1
      BigNumber.from(10).pow(18), // $1
      BigNumber.from(10).pow(18), // $1
    ]
  );

  const SoftVaultOracleFactory = await ethers.getContractFactory(CONTRACT_NAMES.SoftVaultOracle);
  softVaultOracle = <SoftVaultOracle>await upgrades.deployProxy(
    SoftVaultOracleFactory,
    [mockOracle.address, admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );

  await softVaultOracle.deployed();

  const CoreOracle = await ethers.getContractFactory(CONTRACT_NAMES.CoreOracle);
  oracle = <CoreOracle>await upgrades.deployProxy(CoreOracle, [admin.address], { unsafeAllow: ['delegatecall'] });
  await oracle.deployed();

  await oracle.setRoutes(
    [WETH, WBTC, LINK, WstETH, USDC, CRV, DAI, USDT, FRAX, AURA, BAL, ADDRESS.BAL_UDU],
    [
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
      mockOracle.address,
    ]
  );

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
  bWstETH = bTokens.bWstETH;
  bTokenAdmin = bTokens.bTokenAdmin;

  // Deploy Bank
  const Config = await ethers.getContractFactory('ProtocolConfig');
  config = <ProtocolConfig>await upgrades.deployProxy(Config, [treasury.address, admin.address], {
    unsafeAllow: ['delegatecall'],
  });
  await config.deployed();
  // config.startVaultWithdrawFee();

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

  const WERC20 = await ethers.getContractFactory(CONTRACT_NAMES.WERC20);
  werc20 = <WERC20>await upgrades.deployProxy(WERC20, [admin.address], { unsafeAllow: ['delegatecall'] });
  await werc20.deployed();

  // Deploy CRV spell
  const ShortLongSpell = await ethers.getContractFactory(CONTRACT_NAMES.ShortLongSpell);
  shortLongSpell = <ShortLongSpell>(
    await upgrades.deployProxy(
      ShortLongSpell,
      [bank.address, werc20.address, WETH, AUGUSTUS_SWAPPER, TOKEN_TRANSFER_PROXY, admin.address],
      { unsafeAllow: ['delegatecall'] }
    )
  );
  await shortLongSpell.deployed();
  const SoftVault = await ethers.getContractFactory(CONTRACT_NAMES.SoftVault);

  usdcSoftVault = <SoftVault>await upgrades.deployProxy(
    SoftVault,
    [config.address, bUSDC.address, 'Interest Bearing USDC', 'ibUSDC', admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );
  await usdcSoftVault.deployed();
  await bTokenAdmin._setSoftVault(bUSDC.address, usdcSoftVault.address);

  daiSoftVault = <SoftVault>await upgrades.deployProxy(
    SoftVault,
    [config.address, bDAI.address, 'Interest Bearing DAI', 'ibDAI', admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );
  await daiSoftVault.deployed();
  await bTokenAdmin._setSoftVault(bDAI.address, daiSoftVault.address);

  crvSoftVault = <SoftVault>await upgrades.deployProxy(
    SoftVault,
    [config.address, bCRV.address, 'Interest Bearing CRV', 'ibCRV', admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );
  await crvSoftVault.deployed();
  await bTokenAdmin._setSoftVault(bCRV.address, crvSoftVault.address);

  linkSoftVault = <SoftVault>await upgrades.deployProxy(
    SoftVault,
    [config.address, bLINK.address, 'Interest Bearing LINK', 'ibLINK', admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );
  await linkSoftVault.deployed();
  await bTokenAdmin._setSoftVault(bLINK.address, linkSoftVault.address);

  wbtcSoftVault = <SoftVault>await upgrades.deployProxy(
    SoftVault,
    [config.address, bWBTC.address, 'Interest Bearing WBTC', 'ibWBTC', admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );
  await wbtcSoftVault.deployed();
  await bTokenAdmin._setSoftVault(bWBTC.address, wbtcSoftVault.address);

  wethSoftVault = <SoftVault>await upgrades.deployProxy(
    SoftVault,
    [config.address, bWETH.address, 'Interest Bearing WETH', 'ibWETH', admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );
  await wethSoftVault.deployed();
  await bTokenAdmin._setSoftVault(bWETH.address, wethSoftVault.address);

  wstETHSoftVault = <SoftVault>await upgrades.deployProxy(
    SoftVault,
    [config.address, bWstETH.address, 'Interest Bearing WstETH', 'ibWstETH', admin.address],
    {
      unsafeAllow: ['delegatecall'],
    }
  );
  await wstETHSoftVault.deployed();
  await bTokenAdmin._setSoftVault(bWstETH.address, wstETHSoftVault.address);

  await softVaultOracle.registerSoftVault(daiSoftVault.address);
  await softVaultOracle.registerSoftVault(wbtcSoftVault.address);
  await softVaultOracle.registerSoftVault(wethSoftVault.address);
  await softVaultOracle.registerSoftVault(wstETHSoftVault.address);
  await softVaultOracle.registerSoftVault(linkSoftVault.address);
  await softVaultOracle.registerSoftVault(crvSoftVault.address);
  await softVaultOracle.registerSoftVault(usdcSoftVault.address);

  await oracle.setRoutes(
    [
      daiSoftVault.address,
      wbtcSoftVault.address,
      linkSoftVault.address,
      wstETHSoftVault.address,
      crvSoftVault.address,
      usdcSoftVault.address,
      wethSoftVault.address,
    ],
    [
      softVaultOracle.address,
      softVaultOracle.address,
      softVaultOracle.address,
      softVaultOracle.address,
      softVaultOracle.address,
      softVaultOracle.address,
      softVaultOracle.address,
    ]
  );

  await shortLongSpell.addStrategy(daiSoftVault.address, MIN_POS_SIZE, MAX_POS_SIZE);

  await shortLongSpell.setCollateralsMaxLTVs(0, [USDC, USDT, DAI], [MAX_LTV, MAX_LTV, MAX_LTV]);

  await shortLongSpell.addStrategy(linkSoftVault.address, MIN_POS_SIZE, MAX_POS_SIZE);
  await shortLongSpell.setCollateralsMaxLTVs(1, [WBTC, DAI, WETH], [MAX_LTV, MAX_LTV, MAX_LTV]);
  await shortLongSpell.addStrategy(daiSoftVault.address, MIN_POS_SIZE, MAX_POS_SIZE);
  await shortLongSpell.setCollateralsMaxLTVs(2, [WBTC, DAI, WETH, WstETH], [MAX_LTV, MAX_LTV, MAX_LTV, MAX_LTV]);

  await shortLongSpell.addStrategy(wbtcSoftVault.address, MIN_POS_SIZE, MAX_POS_SIZE);
  await shortLongSpell.setCollateralsMaxLTVs(3, [WBTC, DAI, WETH], [MAX_LTV, MAX_LTV, MAX_LTV]);
  await shortLongSpell.addStrategy(wstETHSoftVault.address, MIN_POS_SIZE, MAX_POS_SIZE);
  await shortLongSpell.setCollateralsMaxLTVs(4, [WBTC, DAI, WETH, WstETH], [MAX_LTV, MAX_LTV, MAX_LTV, MAX_LTV]);

  // Setup Bank
  await bank.whitelistSpells([shortLongSpell.address], [true]);
  await bank.whitelistTokens(
    [USDC, USDT, DAI, CRV, WETH, WBTC, LINK, WstETH],
    [true, true, true, true, true, true, true, true]
  );
  await bank.whitelistERC1155([werc20.address], true);

  const softVaults: SoftVault[] = await deploySoftVaults(config, bank, comptroller, bTokens.bTokens, admin, alice);
  
  let softVaultToUnderlying = new Map<string, string>();
  let underlyingToSoftVault = new Map<string, string>();

  for (let i = 0; i < softVaults.length; i++) {
    underlyingToSoftVault.set(await softVaults[i].getUnderlyingToken(), softVaults[i].address);
    await softVaultOracle.registerSoftVault(softVaults[i].address);
    await oracle.setRoutes([softVaults[i].address], [softVaultOracle.address]);
  }

  for (let i=0; i < shortLongStrategies.length; i++) {
    let softVault = underlyingToSoftVault.get(shortLongStrategies[i].softVaultUnderlying);
    
    if (softVault != undefined) {
      await shortLongSpell.addStrategy(softVault, shortLongStrategies[i].minPosition, shortLongStrategies[i].maxPosition);
      await shortLongSpell.setCollateralsMaxLTVs(i, shortLongStrategies[i].collTokens, shortLongStrategies[i].maxLTVs);
    }    
  }

  return {
    werc20,
    mockOracle,
    softVaultOracle,
    oracle,
    config,
    feeManager,
    bank,
    shortLongSpell,
    uniV3Lib: LibInstance,
    strategies: shortLongStrategies,
    underlyingToSoftVault,
  };
};
