import DetectEngine from 'appcd-detect';
import gawk from 'gawk';
import version from './version';

import * as androidlib from 'androidlib';

import { arrayify, debounce as debouncer, get, mergeDeep } from 'appcd-util';
import { bat, cmd, exe } from 'appcd-subprocess';
import { DataServiceDispatcher } from 'appcd-dispatcher';

/**
 * The Android info service.
 */
export default class AndroidInfoService extends DataServiceDispatcher {
	/**
	 * Starts detecting Android information.
	 *
	 * @param {Config} cfg - An Appc Daemon config object.
	 * @returns {Promise}
	 * @access public
	 */
	async activate(cfg) {
		this.config = cfg;

		this.data = gawk({
			devices: [],
			emulators: [],
			ndk: [],
			sdk: [],
			targets: {}
		});

		/**
		 * A map of buckets to a list of active fs watch subscription ids.
		 * @type {Object}
		 */
		this.subscriptions = {};

		if (cfg.android) {
			mergeDeep(androidlib.options, cfg.android);
		}

		await Promise.all([
			this.initDevices(),
			this.initNDKs(),
			this.initSDKsAndEmulators()
		]);
	}

	/**
	 * Initializes device tracking.
	 *
	 * @returns {Promise}
	 * @access private
	 */
	async initDevices() {
		this.trackDeviceHandle = androidlib.devices.trackDevices()
			.on('devices', devices => {
				console.log('Devices changed');
				gawk.set(this.data.devices, devices);
			})
			.on('close', () => {
				console.log('ADB connection was closed');
				gawk.set(this.data.devices, []);
			})
			.once('error', err => {
				console.log('Track devices returned error: %s', err.message);
			});
	}

	/**
	 * Wires up the Android NDK detect engine.
	 *
	 * @returns {Promise}
	 * @access private
	 */
	async initNDKs() {
		const paths = arrayify(get(this.config, 'android.ndk.searchPaths'), true).concat(androidlib.ndk.ndkLocations[process.platform]);

		this.ndkDetectEngine = new DetectEngine({
			checkDir(dir) {
				try {
					return new androidlib.ndk.NDK(dir);
				} catch (e) {
					// 'dir' is not an NDK
				}
			},
			depth:    1,
			env:      'ANDROID_NDK',
			exe:      `ndk-build${cmd}`,
			multiple: true,
			name:     'android:ndk',
			paths,
			processResults: async (results, engine) => {
				if (results.length > 1) {
					results.sort((a, b) => version.compare(a.version, b.version));
				}

				// loop over all of the new ndks and set default version
				if (results.length) {
					let foundDefault = false;
					for (const result of results) {
						if (!foundDefault && (!engine.defaultPath || result.path === engine.defaultPath)) {
							result.default = true;
							foundDefault = true;
						} else {
							result.default = false;
						}
					}

					// no default found the system path, so just select the last/newest one as the default
					if (!foundDefault) {
						results[results.length - 1].default = true;
					}
				}
			},
			recursive:           true,
			recursiveWatchDepth: 0,
			redetect:            true,
			watch:               true
		});

		// listen for ndk results
		this.ndkDetectEngine.on('results', results => {
			gawk.set(this.data.ndk, results);
		});

		await this.ndkDetectEngine.start();
	}

	/**
	 * Wires up the Android SDK detect engine.
	 *
	 * @returns {Promise}
	 * @access private
	 */
	async initSDKsAndEmulators() {
		const paths = arrayify(get(this.config, 'android.sdk.searchPaths'), true).concat(androidlib.sdk.sdkLocations[process.platform]);

		this.sdkDetectEngine = new DetectEngine({
			checkDir(dir) {
				try {
					return new androidlib.sdk.SDK(dir);
				} catch (e) {
					// 'dir' is not an SDK
				}
			},
			depth:    1,
			env:      [ 'ANDROID_SDK', 'ANDROID_SDK_ROOT' ],
			exe:      [ `../../adb${exe}`, `../../android${bat}` ],
			multiple: true,
			name:     'android:sdk',
			paths,
			processResults: async (results, engine) => {
				// loop over all of the new sdks and set default version
				if (results.length) {
					let foundDefault = false;
					for (const result of results) {
						if (!foundDefault && (!engine.defaultPath || result.path === engine.defaultPath)) {
							result.default = true;
							foundDefault = true;
						} else {
							result.default = false;
						}
					}

					if (!foundDefault) {
						// since sdks aren't in any particular order, the first one is a good one
						results[0].default = true;
					}
				}
			},
			recursive: true,
			recursiveWatchDepth: 1,
			redetect: true,
			registryKeys: [
				{
					hive: 'HKLM',
					key: 'SOFTWARE\\Wow6432Node\\Android SDK Tools',
					name: 'Path'
				},
				{
					hive: 'HKLM',
					key: 'SOFTWARE\\Android Studio',
					name: 'SdkPath'
				}
			],
			watch: true
		});

		// listen for sdk results
		this.sdkDetectEngine.on('results', results => {
			gawk.set(this.data.sdk, results);
		});

		let initialized = false;

		this.watch({
			type: 'avd',
			depth: 2,
			paths: [ androidlib.avd.getAvdDir() ],
			debounce: true,
			handler: async () => {
				console.log('Rescanning Android emulators...');
				const emus = await androidlib.emulators.getEmulators({ force: true, sdks: this.data.sdk });
				console.log(`Found ${emus.length} emulators`);
				gawk.set(this.data.emulators, emus);
			}
		});

		return new Promise((resolve, reject) => {
			// if sdks change, then refresh the simulators and update the targets object
			gawk.watch(this.data.sdk, async () => {
				// We need to pause gawk so two events dont fire
				this.data.__gawk__.pause();
				this.data.emulators.__gawk__.pause();
				this.data.targets.__gawk__.pause();

				console.log('AndroidSDK changed, rescanning emulators');
				gawk.set(this.data.emulators, await androidlib.emulators.getEmulators({ force: true, sdks: this.data.sdk }));

				let index = 1;
				const targets = {};

				for (const sdk of this.data.sdk) {
					for (const items of [ sdk.platforms, sdk.addons ]) {
						for (const item of items) {
							const abis = [];
							if (item.abis) {
								for (const type in item.abis) {
									/* eslint-disable max-depth */
									for (const abi of item.abis[type]) {
										if (abis.indexOf(abi) === -1) {
											abis.push(abi);
										}
									}
								}
							}

							const info = {
								id:          item.sdk,
								abis:        abis,
								skins:       item.skins,
								name:        item.name,
								type:        item.platform,
								path:        item.path,
								revision:    item.revision,
								androidJar:  item.androidJar,
								aidl:        item.aidl
							};

							if (item.basedOn) {
								// This is an addon
								info.type = 'add-on';
								info.vendor = item.vendor;
								info.description = item.description;
								info.version = item.basedOn.version || parseInt(String(item.basedOn).replace(/^android-/, '')) || null;
								info['based-on'] = {
									'android-version': item.basedOn.version,
									'api-level': item.basedOn.apiLevel
								};
							} else {
								info.type = 'platform';
								info['api-level'] = item.apiLevel;
								info.sdk = item.apiLevel;
								info.version = item.version;
							}

							targets[index++] = info;
						}
					}
				}
				gawk.set(this.data.targets, targets);

				// Now we need to resume gawk
				this.data.targets.__gawk__.resume();
				this.data.emulators.__gawk__.resume();
				this.data.__gawk__.resume();

				if (!initialized) {
					initialized = true;
					resolve();
				}
			});

			this.sdkDetectEngine.start()
				.then(async results => {
					// if there's no results, then the gawk watch above never gets called
					if (!initialized && results.length === 0) {
						initialized = true;
						gawk.set(this.data.emulators, await androidlib.emulators.getEmulators({ force: true, sdks: this.data.sdk }));
						resolve();
					}
				})
				.catch(reject);
		});
	}

	/**
	 * Subscribes to filesystem events for the specified paths.
	 *
	 * @param {Object} params - Various parameters.
	 * @param {Boolean} [params.debounce=false] - When `true`, wraps the `handler` with a debouncer.
	 * @param {Number} [params.depth] - The max depth to recursively watch.
	 * @param {Function} params.handler - A callback function to fire when a fs event occurs.
	 * @param {Array.<String>} params.paths - One or more paths to watch.
	 * @param {String} params.type - The type of subscription.
	 * @access private
	 */
	watch({ debounce, depth, handler, paths, type }) {
		const callback = debounce ? debouncer(handler) : handler;

		for (const path of paths) {
			const data = { path };
			if (depth) {
				data.recursive = true;
				data.depth = depth;
			}

			appcd
				.call('/appcd/fswatch', {
					data,
					type: 'subscribe'
				})
				.then(ctx => {
					let sid;
					ctx.response
						.on('data', async (data) => {
							if (data.type === 'subscribe') {
								sid = data.sid;
								if (!this.subscriptions[type]) {
									this.subscriptions[type] = {};
								}
								this.subscriptions[type][data.sid] = 1;
							} else if (data.type === 'event') {
								callback(data.message);
							}
						})
						.on('end', () => {
							if (sid && this.subscriptions[type]) {
								delete this.subscriptions[type][sid];
							}
						});
				});
		}
	}

	/**
	 * Unsubscribes a list of filesystem watcher subscription ids.
	 *
	 * @param {Number} type - The type of subscription.
	 * @param {Array.<String>} [sids] - An array of subscription ids to unsubscribe. If not
	 * specified, defaults to all sids for the specified types.
	 * @returns {Promise}
	 * @access private
	 */
	async unwatch(type, sids) {
		if (!this.subscriptions[type]) {
			return;
		}

		if (!sids) {
			sids = Object.keys(this.subscriptions[type]);
		}

		for (const sid of sids) {
			await appcd.call('/appcd/fswatch', {
				sid,
				type: 'unsubscribe'
			});

			delete this.subscriptions[type][sid];
		}

		if (!Object.keys(this.subscriptions[type]).length) {
			delete this.subscriptions[type];
		}
	}

	/**
	 * Stops the detect engines.
	 *
	 * @returns {Promise}
	 * @access public
	 */
	async deactivate() {
		if (this.sdkDetectEngine) {
			await this.sdkDetectEngine.stop();
			this.sdkDetectEngine = null;
		}

		if (this.ndkDetectEngine) {
			await this.ndkDetectEngine.stop();
			this.ndkDetectEngine = null;
		}

		if (this.subscriptions) {
			for (const type of Object.keys(this.subscriptions)) {
				await this.unwatch(type);
			}
		}
	}
}
