import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import chai, { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { ethers, upgrades } from 'hardhat';
import {
	BlueBerryBank,
	CoreOracle,
	ICErc20,
	IchiVaultSpell,
	IWETH,
	MockOracle,
	SoftVault,
	IchiLpOracle,
	IIchiFarm,
	WERC20,
	WIchiFarm,
	ProtocolConfig,
	MockERC20,
	IComptroller,
	MockIchiVault,
	MockIchiFarm,
	ERC20,
	IUniswapV2Router02,
	MockIchiV2,
	HardVault
} from '../../typechain-types';
import { ADDRESS, CONTRACT_NAMES } from '../../constant';
import ICrc20ABI from '../../abi/ICErc20.json'
import SpellABI from '../../abi/IchiVaultSpell.json';
import IchiFarmABI from '../../abi/IIchiFarm.json';
import { abi as QuoterABI } from '@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json'

import { solidity } from 'ethereum-waffle'
import { near } from '../assertions/near'
import { roughlyNear } from '../assertions/roughlyNear'
import { evm_mine_blocks } from '../helpers';

chai.use(solidity)
chai.use(near)
chai.use(roughlyNear)

const CUSDC = ADDRESS.bUSDC;
const CICHI = ADDRESS.bICHI;
const WETH = ADDRESS.WETH;
const USDC = ADDRESS.USDC;
const ICHI = ADDRESS.ICHI;
const ICHIV1 = ADDRESS.ICHI_FARM;
const ICHI_VAULT_PID = 0; // ICHI/USDC Vault PoolId
const ETH_PRICE = 1600;

describe('ICHI Angel Vaults Spell', () => {
	let admin: SignerWithAddress;
	let alice: SignerWithAddress;
	let treasury: SignerWithAddress;

	let usdc: ERC20;
	let ichi: MockIchiV2;
	let ichiV1: ERC20;
	let weth: IWETH;
	let cUSDC: ICErc20;
	let werc20: WERC20;
	let mockOracle: MockOracle;
	let ichiOracle: IchiLpOracle;
	let oracle: CoreOracle;
	let spell: IchiVaultSpell;
	let wichi: WIchiFarm;
	let config: ProtocolConfig;
	let bank: BlueBerryBank;
	let usdcSoftVault: SoftVault;
	let ichiSoftVault: SoftVault;
	let usdcIchiHardVault: HardVault;
	let ichiFarm: MockIchiFarm;
	let ichiVault: MockIchiVault;

	before(async () => {
		[admin, alice, treasury] = await ethers.getSigners();
		console.log(admin.address)
		usdc = <ERC20>await ethers.getContractAt("ERC20", USDC, admin);
		ichi = <MockIchiV2>await ethers.getContractAt("MockIchiV2", ICHI, admin);
		ichiV1 = <ERC20>await ethers.getContractAt("ERC20", ICHIV1, admin);
		weth = <IWETH>await ethers.getContractAt(CONTRACT_NAMES.IWETH, WETH);

		// Prepare USDC
		// deposit 80 eth -> 80 WETH
		await weth.deposit({ value: utils.parseUnits('80') });

		// swap 40 weth -> usdc
		await weth.approve(ADDRESS.UNI_V2_ROUTER, ethers.constants.MaxUint256);
		const uniV2Router = <IUniswapV2Router02>await ethers.getContractAt(
			CONTRACT_NAMES.IUniswapV2Router02,
			ADDRESS.UNI_V2_ROUTER
		);
		await uniV2Router.swapExactTokensForTokens(
			utils.parseUnits('40'),
			0,
			[WETH, USDC],
			admin.address,
			ethers.constants.MaxUint256
		)
		// Swap 40 weth -> ichi
		await weth.approve(ADDRESS.SUSHI_ROUTER, ethers.constants.MaxUint256);
		const sushiRouter = <IUniswapV2Router02>await ethers.getContractAt(
			CONTRACT_NAMES.IUniswapV2Router02,
			ADDRESS.SUSHI_ROUTER
		);
		await sushiRouter.swapExactTokensForTokens(
			utils.parseUnits('40'),
			0,
			[WETH, ICHIV1],
			admin.address,
			ethers.constants.MaxUint256
		)
		await ichiV1.approve(ICHI, ethers.constants.MaxUint256);
		const ichiV1Balance = await ichiV1.balanceOf(admin.address);
		await ichi.convertToV2(ichiV1Balance);
		console.log("ICHI Balance:", utils.formatEther(await ichi.balanceOf(admin.address)));

		const LinkedLibFactory = await ethers.getContractFactory("UniV3WrappedLib");
		const LibInstance = await LinkedLibFactory.deploy();

		const IchiVault = await ethers.getContractFactory("MockIchiVault", {
			libraries: {
				UniV3WrappedLibMockup: LibInstance.address
			}
		});
		ichiVault = await IchiVault.deploy(
			ADDRESS.UNI_V3_ICHI_USDC,
			true,
			true,
			admin.address,
			admin.address,
			3600
		)
		await usdc.approve(ichiVault.address, utils.parseUnits("100", 6));
		await ichi.approve(ichiVault.address, utils.parseUnits("100", 18));
		await ichiVault.deposit(utils.parseUnits("100", 18), utils.parseUnits("100", 6), admin.address)

		const WERC20 = await ethers.getContractFactory(CONTRACT_NAMES.WERC20);
		werc20 = <WERC20>await upgrades.deployProxy(WERC20);
		await werc20.deployed();

		const MockOracle = await ethers.getContractFactory(CONTRACT_NAMES.MockOracle);
		mockOracle = <MockOracle>await MockOracle.deploy();
		await mockOracle.deployed();
		await mockOracle.setPrice(
			[WETH, USDC, ICHI],
			[
				BigNumber.from(10).pow(18).mul(ETH_PRICE),
				BigNumber.from(10).pow(18), // $1
				BigNumber.from(10).pow(18).mul(5), // $5
			],
		)

		const IchiLpOracle = await ethers.getContractFactory(CONTRACT_NAMES.IchiLpOracle);
		ichiOracle = <IchiLpOracle>await IchiLpOracle.deploy(mockOracle.address);
		await ichiOracle.deployed();

		const CoreOracle = await ethers.getContractFactory(CONTRACT_NAMES.CoreOracle);
		oracle = <CoreOracle>await CoreOracle.deploy();
		await oracle.deployed();

		await oracle.setWhitelistERC1155([werc20.address, ichiVault.address], true);
		await oracle.setTokenSettings(
			[WETH, USDC, ICHI, ichiVault.address],
			[{
				liqThreshold: 9000,
				route: mockOracle.address,
			}, {
				liqThreshold: 8000,
				route: mockOracle.address,
			}, {
				liqThreshold: 9000,
				route: mockOracle.address,
			}, {
				liqThreshold: 10000,
				route: ichiOracle.address,
			}]
		)

		// Deploy Bank
		const Config = await ethers.getContractFactory("ProtocolConfig");
		config = <ProtocolConfig>await upgrades.deployProxy(Config, [treasury.address]);

		const BlueBerryBank = await ethers.getContractFactory(CONTRACT_NAMES.BlueBerryBank);
		bank = <BlueBerryBank>await upgrades.deployProxy(BlueBerryBank, [oracle.address, config.address]);
		await bank.deployed();

		// Deploy ICHI wrapper and spell
		const MockIchiFarm = await ethers.getContractFactory("MockIchiFarm");
		ichiFarm = <MockIchiFarm>await MockIchiFarm.deploy(
			ADDRESS.ICHI_FARM,
			ethers.utils.parseUnits("1", 9) // 1 ICHI.FARM per block
		);
		const WIchiFarm = await ethers.getContractFactory(CONTRACT_NAMES.WIchiFarm);
		wichi = <WIchiFarm>await upgrades.deployProxy(WIchiFarm, [
			ADDRESS.ICHI,
			ADDRESS.ICHI_FARM,
			ichiFarm.address
		]);
		await wichi.deployed();

		const ICHISpell = await ethers.getContractFactory(CONTRACT_NAMES.IchiVaultSpell);
		spell = <IchiVaultSpell>await upgrades.deployProxy(ICHISpell, [
			bank.address,
			werc20.address,
			WETH,
			wichi.address
		])
		await spell.deployed();
		await spell.addStrategy(ichiVault.address, utils.parseUnits("200000", 6));
		await spell.addCollaterals(
			0,
			[USDC, ICHI],
			[30000, 30000]
		);
		await spell.setWhitelistLPTokens([ichiVault.address], [true]);
		await oracle.setWhitelistERC1155([wichi.address], true);

		// Setup Bank
		await bank.whitelistSpells(
			[spell.address],
			[true]
		)
		await bank.whitelistTokens([USDC, ICHI], [true, true]);

		const HardVault = await ethers.getContractFactory(CONTRACT_NAMES.HardVault);
		usdcIchiHardVault = <HardVault>await upgrades.deployProxy(HardVault, [
			bank.address,
			USDC,
			"Interest Bearing USDC",
			"ibUSDC"
		])
		// Deposit 10k USDC to compound
		const SoftVault = await ethers.getContractFactory(CONTRACT_NAMES.SoftVault);
		usdcSoftVault = <SoftVault>await upgrades.deployProxy(SoftVault, [
			bank.address,
			CUSDC,
			"Interest Bearing USDC",
			"ibUSDC"
		])
		await usdcSoftVault.deployed();
		await bank.addBank(USDC, CUSDC, usdcSoftVault.address, usdcIchiHardVault.address);

		ichiSoftVault = <SoftVault>await upgrades.deployProxy(SoftVault, [
			bank.address,
			CICHI,
			"Interest Bearing ICHI",
			"ibICHI"
		]);
		await ichiSoftVault.deployed();
		await bank.addBank(ICHI, CICHI, ichiSoftVault.address, usdcIchiHardVault.address);

		await usdc.approve(usdcSoftVault.address, ethers.constants.MaxUint256);
		await usdc.transfer(alice.address, utils.parseUnits("500", 6));
		await usdcSoftVault.deposit(utils.parseUnits("10000", 6));

		await ichi.approve(ichiSoftVault.address, ethers.constants.MaxUint256);
		await ichi.transfer(alice.address, utils.parseUnits("500", 18));
		await ichiSoftVault.deposit(utils.parseUnits("10000", 6));

		// Enter markets
		// await bank.enterMarkets(ADDRESS.COMP, [CUSDC, CICHI]);
		// Whitelist bank contract on compound
		const compound = <IComptroller>await ethers.getContractAt("IComptroller", ADDRESS.COMP, admin);
		await compound.connect(admin)._setCreditLimit(bank.address, CUSDC, utils.parseUnits("3000000"));
		await compound.connect(admin)._setCreditLimit(bank.address, CICHI, utils.parseUnits("3000000"));

		// Add new ichi vault to farming pool
		await ichiFarm.add(100, ichiVault.address);
	})

	beforeEach(async () => {
	})

	// describe("Constructor", async () => {
	// 	it("Spell test cases are disabled at the moment", async () => { })
	// })

	describe("ICHI Vault Poisition", () => {
		const depositAmount = utils.parseUnits('100', 18);
		const borrowAmount = utils.parseUnits('300', 6);

		it("should be able to deposit USDC on ICHI angel vault", async () => {
			const beforeTreasuryBalance = await ichi.balanceOf(treasury.address);
			const iface = new ethers.utils.Interface(SpellABI);
			await usdc.approve(bank.address, ethers.constants.MaxUint256);
			await ichi.approve(bank.address, ethers.constants.MaxUint256);
			// Isolated collateral: ICHI
			// Borrow: USDC
			await bank.execute(
				0,
				spell.address,
				iface.encodeFunctionData("openPosition", [
					0, ICHI, USDC, depositAmount, borrowAmount
				])
			)

			expect(await bank.nextPositionId()).to.be.equal(BigNumber.from(2));
			const pos = await bank.getPositionInfo(1);
			expect(pos.owner).to.be.equal(admin.address);
			expect(pos.collToken).to.be.equal(werc20.address);
			expect(pos.collId).to.be.equal(BigNumber.from(ichiVault.address));
			expect(pos.collateralSize.gt(ethers.constants.Zero)).to.be.true;
			expect(
				await werc20.balanceOf(bank.address, BigNumber.from(ichiVault.address))
			).to.be.equal(pos.collateralSize);
			const bankInfo = await bank.banks(USDC);
			console.log('Bank Info', bankInfo);
			console.log('Position Info', pos);

			const afterTreasuryBalance = await ichi.balanceOf(treasury.address);
			expect(
				afterTreasuryBalance.sub(beforeTreasuryBalance)
			).to.be.equal(depositAmount.mul(50).div(10000))
		})
		it("should be able to return position risk ratio", async () => {
			let risk = await bank.getPositionRisk(1);
			console.log('Prev Position Risk', utils.formatUnits(risk, 2), '%');
			await mockOracle.setPrice(
				[USDC, ICHI],
				[
					BigNumber.from(10).pow(18), // $1
					BigNumber.from(10).pow(17).mul(40), // $4
				]
			);
			risk = await bank.getPositionRisk(1);
			console.log('Position Risk', utils.formatUnits(risk, 2), '%');
		})
		it("should be able to withdraw USDC", async () => {
			await ichiVault.rebalance(-260400, -260200, -260800, -260600, 0);
			await usdc.transfer(spell.address, utils.parseUnits('10', 6)); // manually set rewards

			const beforeTreasuryBalance = await ichi.balanceOf(treasury.address);
			const beforeUSDCBalance = await usdc.balanceOf(admin.address);
			const beforeIchiBalance = await ichi.balanceOf(admin.address);

			const iface = new ethers.utils.Interface(SpellABI);
			await bank.execute(
				1,
				spell.address,
				iface.encodeFunctionData("closePosition", [
					0,
					ICHI,
					USDC, // ICHI vault lp token is collateral
					ethers.constants.MaxUint256,	// Amount of werc20
					ethers.constants.MaxUint256,  // Amount of 
					0,
					ethers.constants.MaxUint256,
				])
			)
			const afterUSDCBalance = await usdc.balanceOf(admin.address);
			const afterIchiBalance = await ichi.balanceOf(admin.address);
			console.log('USDC Balance Change:', afterUSDCBalance.sub(beforeUSDCBalance));
			console.log('ICHI Balance Change:', afterIchiBalance.sub(beforeIchiBalance));
			const depositFee = depositAmount.mul(50).div(10000);
			const withdrawFee = depositAmount.sub(depositFee).mul(50).div(10000);
			expect(afterIchiBalance.sub(beforeIchiBalance)).to.be.gte(depositAmount.sub(depositFee).sub(withdrawFee));

			const afterTreasuryBalance = await ichi.balanceOf(treasury.address);
			expect(afterTreasuryBalance.sub(beforeTreasuryBalance)).to.be.equal(withdrawFee);
		})
	})

	describe("ICHI Vault Farming Position", () => {
		const depositAmount = utils.parseUnits('100', 18);
		const borrowAmount = utils.parseUnits('200', 6);
		it("should be able to farm USDC on ICHI angel vault", async () => {
			const beforeTreasuryBalance = await ichi.balanceOf(treasury.address);

			const iface = new ethers.utils.Interface(SpellABI);
			await usdc.approve(bank.address, ethers.constants.MaxUint256);
			await ichi.approve(bank.address, ethers.constants.MaxUint256);
			await bank.execute(
				0,
				spell.address,
				iface.encodeFunctionData("openPositionFarm", [
					0,
					ICHI,
					USDC,
					depositAmount,
					borrowAmount,
					ICHI_VAULT_PID // ICHI/USDC Vault Pool Id
				])
			)

			expect(await bank.nextPositionId()).to.be.equal(BigNumber.from(2));
			const pos = await bank.getPositionInfo(1);
			expect(pos.owner).to.be.equal(admin.address);
			expect(pos.collToken).to.be.equal(wichi.address);
			const poolInfo = await ichiFarm.poolInfo(ICHI_VAULT_PID);
			const collId = await wichi.encodeId(ICHI_VAULT_PID, poolInfo.accIchiPerShare);
			expect(pos.collId).to.be.equal(collId);
			expect(pos.collateralSize.gt(ethers.constants.Zero)).to.be.true;
			expect(
				await wichi.balanceOf(bank.address, collId)
			).to.be.equal(pos.collateralSize);

			const afterTreasuryBalance = await ichi.balanceOf(treasury.address);
			expect(
				afterTreasuryBalance.sub(beforeTreasuryBalance)
			).to.be.equal(depositAmount.mul(50).div(10000))
		})
		it("should be able to return position risk ratio", async () => {
			let risk = await bank.getPositionRisk(1);
			console.log('Prev Position Risk', utils.formatUnits(risk, 2), '%');
			await mockOracle.setPrice(
				[USDC, ICHI],
				[
					BigNumber.from(10).pow(18), // $1
					BigNumber.from(10).pow(17).mul(40), // $4
				]
			);
			risk = await bank.getPositionRisk(1);
			console.log('Position Risk', utils.formatUnits(risk, 2), '%');
		})
		it("should be able to harvest on ICHI farming", async () => {
			evm_mine_blocks(1000);
			await ichiVault.rebalance(-260400, -260200, -260800, -260600, 0);
			await usdc.transfer(spell.address, utils.parseUnits('10', 6)); // manually set rewards

			const pendingIchi = await ichiFarm.pendingIchi(ICHI_VAULT_PID, wichi.address);
			console.log("Pending Rewards:", pendingIchi);
			const legacyIchi = await ethers.getContractAt("MockERC20", ADDRESS.ICHI_FARM, admin);
			await legacyIchi.mint(ichiFarm.address, pendingIchi.mul(10000000));

			const beforeTreasuryBalance = await ichi.balanceOf(treasury.address);
			const beforeUSDCBalance = await usdc.balanceOf(admin.address);
			const beforeIchiBalance = await ichi.balanceOf(admin.address);

			const iface = new ethers.utils.Interface(SpellABI);
			await bank.execute(
				1,
				spell.address,
				iface.encodeFunctionData("closePositionFarm", [
					0,
					ICHI,
					USDC, // ICHI vault lp token is collateral
					ethers.constants.MaxUint256,	// Amount of werc20
					ethers.constants.MaxUint256,  // Amount of repay
					0,
					ethers.constants.MaxUint256,
				])
			)
			const afterUSDCBalance = await usdc.balanceOf(admin.address);
			const afterIchiBalance = await ichi.balanceOf(admin.address);
			console.log('USDC Balance Change:', afterUSDCBalance.sub(beforeUSDCBalance));
			console.log('ICHI Balance Change:', afterIchiBalance.sub(beforeIchiBalance));
			const depositFee = depositAmount.mul(50).div(10000);
			const withdrawFee = depositAmount.sub(depositFee).mul(50).div(10000);
			expect(afterIchiBalance.sub(beforeIchiBalance)).to.be.gte(depositAmount.sub(depositFee).sub(withdrawFee));

			const afterTreasuryBalance = await ichi.balanceOf(treasury.address);
			expect(afterTreasuryBalance.sub(beforeTreasuryBalance)).to.be.equal(withdrawFee);
		})
	})
})