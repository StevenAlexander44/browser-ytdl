// ==UserScript==
// @name         Local YouTube Downloader
// @version      1.4
// @author       Some Guy
// @description  Download YouTube videos without external service.
// @match        https://*.youtube.com/*
// @require      https://unpkg.com/vue@2.6.10/dist/vue.js
// @require      https://unpkg.com/xfetch-js@0.3.4/xfetch.min.js
// @require      https://unpkg.com/@ffmpeg/ffmpeg@0.6.1/dist/ffmpeg.min.js
// @require      https://bundle.run/p-queue@6.3.0
// @connect      googlevideo.com
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// ==/UserScript==

;(function() {
	'use strict'
	const DEBUG = true
	const createLogger = (console, tag) => Object.keys(console).map(k => [k, (...args) => (DEBUG ? console[k](tag + ': ' + args[0], ...args.slice(1)) : void 0)]).reduce((acc, [k, fn]) => ((acc[k] = fn), acc), {})
	const logger = createLogger(console, 'YTDL')
	const sleep = ms => new Promise(res => setTimeout(res, ms))
	const strings = {
		togglelinks: 'Show/Hide Links',
		both: 'Video and Audio',
		dllow: 'Custom resolution mp4',
		dlmp4: 'High resolution mp4',
		audio: 'Audio Only',
		highvideo: 'High Quality Video Only',
		lowvideo: 'Low Quality Video Only',
		get_video_failed: 'Failed to get video infomation for unknown reason, refresh the page may work.',
		live_stream_disabled_message: 'Local YouTube Downloader is not available for live stream'
	}
	const $ = (s, x = document) => x.querySelector(s)
	const $el = (tag, opts) => {
		const el = document.createElement(tag)
		Object.assign(el, opts)
		return el
	}
	const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const parseDecsig = data => {
		try {
			if (data.startsWith('var script')) {
				// they inject the script via script tag
				const obj = {}
				const document = {
					createElement: () => obj,
					head: {
						appendChild: () => {}
					}
				}
				eval(data)
				data = obj.innerHTML
			}
			const fnnameresult = /=([a-zA-Z0-9\$_]+?)\(decodeURIComponent/.exec(data)
			const fnname = fnnameresult[1]
			const _argnamefnbodyresult = new RegExp(escapeRegExp(fnname) + '=function\\((.+?)\\){((.+)=\\2.+?)}').exec(data)
			const [_, argname, fnbody] = _argnamefnbodyresult
			const helpernameresult = /;([a-zA-Z0-9$_]+?)\..+?\(/.exec(fnbody)
			const helpername = helpernameresult[1]
			const helperresult = new RegExp('var ' + escapeRegExp(helpername) + '={[\\s\\S]+?};').exec(data)
			const helper = helperresult[0]
			logger.log(`parsedecsig result: %s=>{%s\n%s}`, argname, helper, fnbody)
			return new Function([argname], helper + '\n' + fnbody)
		}
		catch (e) {
			logger.error('parsedecsig error: %o', e)
			logger.info('script content: %s', data)
			logger.info('If you encounter this error, please copy the full "script content" to https://pastebin.com/ for me.')
		}
	}
	const parseQuery = s => [...new URLSearchParams(s).entries()].reduce((acc, [k, v]) => ((acc[k] = v), acc), {})
	const parseResponse = (id, playerResponse, decsig) => {
		logger.log(`video %s playerResponse: %o`, id, playerResponse)
		let stream = []
		if (playerResponse.streamingData.formats) {
			stream = playerResponse.streamingData.formats.map(x => Object.assign({}, x, parseQuery(x.cipher || x.signatureCipher)))
			logger.log(`video %s stream: %o`, id, stream)
			for (const obj of stream) {
				if (obj.s) {
					obj.s = decsig(obj.s)
					obj.url += `&${obj.sp}=${encodeURIComponent(obj.s)}`
				}
			}
		}
		let adaptive = []
		if (playerResponse.streamingData.adaptiveFormats) {
			adaptive = playerResponse.streamingData.adaptiveFormats.map(x => Object.assign({}, x, parseQuery(x.cipher || x.signatureCipher)))
			logger.log(`video %s adaptive: %o`, id, adaptive)
			for (const obj of adaptive) {
				if (obj.s) {
					obj.s = decsig(obj.s)
					obj.url += `&${obj.sp}=${encodeURIComponent(obj.s)}`
				}
			}
		}
		logger.log(`video %s result: %o`, id, {
			stream,
			adaptive
		})
		return {
			stream,
			adaptive,
			details: playerResponse.videoDetails,
			playerResponse
		}
	}
	// video downloader
	const xhrDownloadUint8Array = async ({
		url,
		contentLength
	}, progressCb) => {
		if (typeof contentLength === 'string') contentLength = parseInt(contentLength)
		progressCb({
			loaded: 0,
			total: contentLength,
			speed: 0
		})
		const chunkSize = 65536
		const getBuffer = (start, end) => fetch(url + `&range=${start}-${end ? end - 1 : ''}`).then(r => r.arrayBuffer())
		const data = new Uint8Array(contentLength)
		let downloaded = 0
		const queue = new pQueue.default({
			concurrency: 6
		})
		const startTime = Date.now()
		const ps = []
		for (let start = 0; start < contentLength; start += chunkSize) {
			const exceeded = start + chunkSize > contentLength
			const curChunkSize = exceeded ? contentLength - start : chunkSize
			const end = exceeded ? null : start + chunkSize
			const p = queue.add(() => {
				console.log('dl start', url, start, end)
				return getBuffer(start, end).then(buf => {
					console.log('dl done', url, start, end)
					downloaded += curChunkSize
					data.set(new Uint8Array(buf), start)
					const ds = (Date.now() - startTime + 1) / 1000
					progressCb({
						loaded: downloaded,
						total: contentLength,
						speed: downloaded / ds
					})
				}).catch(err => {
					queue.clear()
					alert('Download error')
				})
			})
			ps.push(p)
		}
		await Promise.all(ps)
		return data
	}
	const ffWorker = FFmpeg.createWorker({
		logger: DEBUG ? m => logger.log(m.message) : () => {}
	})
	let ffWorkerLoaded = false
	const mergeVideo = async (video, audio) => {
		if (!ffWorkerLoaded) await ffWorker.load()
		await ffWorker.write('video.mp4', video)
		await ffWorker.write('audio.mp4', audio)
		await ffWorker.run('-i video.mp4 -i audio.mp4 -c copy output.mp4', {
			input: ['video.mp4', 'audio.mp4'],
			output: 'output.mp4'
		})
		const {
			data
		} = await ffWorker.read('output.mp4')
		await ffWorker.remove('output.mp4')
		return data
	}
	const triggerDownload = (url, filename) => {
		const a = document.createElement('a')
		a.href = url
		a.download = filename
		document.body.appendChild(a)
		a.click()
		a.remove()
	}
	const dlModalTemplate = `
<div style="width: 100%; height: 100%;">
	<div v-if="merging" style="height: 100%; width: 100%; display: flex; justify-content: center; align-items: center; font-size: 24px;">Merging video, please wait...</div>
	<div v-else style="height: 100%; width: 100%; display: flex; flex-direction: column;">
 		<div style="flex: 1; margin: 10px;">
			<p style="font-size: 24px;">Video</p>
			<progress style="width: 100%;" :value="video.progress" min="0" max="100"></progress>
			<div style="display: flex; justify-content: space-between;">
				<span>{{video.speed}} kB/s</span>
				<span>{{video.loaded}}/{{video.total}} MB</span>
			</div>
		</div>
		<div style="flex: 1; margin: 10px;">
			<p style="font-size: 24px;">Audio</p>
			<progress style="width: 100%;" :value="audio.progress" min="0" max="100"></progress>
			<div style="display: flex; justify-content: space-between;">
				<span>{{audio.speed}} kB/s</span>
				<span>{{audio.loaded}}/{{audio.total}} MB</span>
			</div>
		</div>
	</div>
</div>
`

	function openDownloadModel(adaptive, title, type) {
		const win = open('', 'Video Download', `toolbar=no,height=${screen.height / 2},width=${screen.width / 2},left=${screenLeft},top=${screenTop}`)
		const div = win.document.createElement('div')
		win.document.body.appendChild(div)
		win.document.title = `Downloading "${title}"`
		const dlModalApp = new Vue({
			template: dlModalTemplate,
			data() {
				return {
					video: {
						progress: 0,
						total: 0,
						loaded: 0,
						speed: 0
					},
					audio: {
						progress: 0,
						total: 0,
						loaded: 0,
						speed: 0
					},
					merging: false
				}
			},
			methods: {
				async start(adaptive, title, type) {
					win.onbeforeunload = () => true
					// YouTube's default order is descending by video quality
					var videoObj;
					var audioObj;
					if (type == 'high') {
						videoObj = adaptive.filter(x => x.mimeType.includes('video/mp4') || x.mimeType.includes('video/webm')).map(v => {
							const [_, quality, fps] = /(\d+)p(\d*)/.exec(v.qualityLabel)
							v.qualityNum = parseInt(quality)
							v.fps = fps ? parseInt(fps) : 30
							return v
						}).sort((a, b) => {
							if (a.qualityNum === b.qualityNum) return b.fps - a.fps // ex: 30-60=-30, then a will be put before b
							return b.qualityNum - a.qualityNum
						})[0]
						audioObj = adaptive.find(x => x.mimeType.includes('audio/mp4'))
					}
					else {
						var codes = type.split('|')
						var videoCode = codes[0]
						var audioCode = codes[1]
						videoObj = adaptive.find(x => x.itag == videoCode);
						audioObj = adaptive.find(x => x.itag == audioCode);
					}
					const vPromise = xhrDownloadUint8Array(videoObj, e => {
						this.video.progress = (e.loaded / e.total) * 100
						this.video.loaded = (e.loaded / 1024 / 1024).toFixed(2)
						this.video.total = (e.total / 1024 / 1024).toFixed(2)
						this.video.speed = (e.speed / 1024).toFixed(2)
					})
					const aPromise = xhrDownloadUint8Array(audioObj, e => {
						this.audio.progress = (e.loaded / e.total) * 100
						this.audio.loaded = (e.loaded / 1024 / 1024).toFixed(2)
						this.audio.total = (e.total / 1024 / 1024).toFixed(2)
						this.audio.speed = (e.speed / 1024).toFixed(2)
					})
					const [varr, aarr] = await Promise.all([vPromise, aPromise])
					this.merging = true
					win.onunload = () => {
						// trigger download when user close it
						const bvurl = URL.createObjectURL(new Blob([varr]))
						const baurl = URL.createObjectURL(new Blob([aarr]))
						triggerDownload(bvurl, title + '-videoonly.mp4')
						triggerDownload(baurl, title + '-audioonly.mp4')
					}
					const result = await Promise.race([mergeVideo(varr, aarr), sleep(1000 * 25).then(() => null)])
					if (!result) {
						alert('An error has occurred when merging video')
						const bvurl = URL.createObjectURL(new Blob([varr]))
						const baurl = URL.createObjectURL(new Blob([aarr]))
						triggerDownload(bvurl, title + '-videoonly.mp4')
						triggerDownload(baurl, title + '-audioonly.mp4')
						return this.close()
					}
					this.merging = false
					const url = URL.createObjectURL(new Blob([result]))
					triggerDownload(url, title + '.mp4')
					win.onbeforeunload = null
					win.onunload = null
					win.close()
				}
			}
		}).$mount(div)
		dlModalApp.start(adaptive, title, type)
	}
	const template = `
<div class="box" :class="{'dark':dark}">
	<template v-if="!isLiveStream">
		<div @click="hide=!hide" class="box-toggle div-a t-center fs-14px c-pointer lh-20" v-text="strings.togglelinks"></div>
		<div :class="{'hide':hide}">
			<div class="d-flex">
				<div class="f-1 of-h">
					<div class="t-center fs-14px" v-text="strings.both"></div>
					<a class="ytdl-link-btn fs-14px t-center c-pointer" @click="dllow" v-text="strings.dllow"></a>
					<a class="ytdl-link-btn fs-14px" target="_blank" v-for="vid in stream" :href="vid.url" :title="vid.type" v-text="formatText(vid)"></a>
					<a class="ytdl-link-btn fs-14px t-center c-pointer" @click="dlmp4" v-text="strings.dlmp4"></a>
					<div class="t-center fs-14px" v-text="strings.audio"></div>
					<a class="ytdl-link-btn fs-14px" target="_blank" v-for="vid in audio" :href="vid.url" :title="vid.type" v-text="formatText(vid)"></a>
					<div class="t-center fs-14px" v-text="strings.highvideo"></div>
					<a class="ytdl-link-btn fs-14px" target="_blank" v-for="vid in highvideo" :href="vid.url" :title="vid.type" v-text="formatText(vid)"></a>
				</div>
				<div class="f-1 of-h">
					<div class="t-center fs-14px" v-text="strings.lowvideo"></div>
					<a class="ytdl-link-btn fs-14px" target="_blank" v-for="vid in lowvideo" :href="vid.url" :title="vid.type" v-text="formatText(vid)"></a>
				</div>
			</div>
		</div>
	</template>
	<template v-else>
		<div class="t-center fs-14px lh-20" v-text="strings.live_stream_disabled_message"></div>
	</template>
</div>
`.slice(1)
	const app = new Vue({
		data() {
			return {
				hide: true,
				id: '',
				isLiveStream: false,
				stream: [],
				adaptive: [],
				details: null,
				dark: false
			}
		},
		computed: {
			strings() {
				return strings
			}
		},
		methods: {
			dllow() {
				let vCode = parseInt(prompt("Video code", 160))
				let aCode = parseInt(prompt("Audio code", 140))
				openDownloadModel(this.adaptive, this.details.title, vCode + '|' + aCode)
			},
			dlmp4() {
				openDownloadModel(this.adaptive, this.details.title, 'high')
			},
			formatText(vid) {
				let id = vid.itag
				let size = `${(vid.contentLength/1024/1024).toFixed(2)}MiB`
				if (!vid.contentLength) {
					size = `${(vid.approxDurationMs/1000*vid.bitrate/8/1024/1024).toFixed(2)}MiB`
				}
				let res = `${vid.width}x${vid.height}@${vid.fps}fps`
				let ext = vid.mimeType.split(';')[0].split('/')[1]
				let codec = vid.mimeType.split('=')[1]
				var formatted = [id, size, res, ext, codec]
				if (!vid.mimeType.includes('video')) {
					formatted = [id, size, ext, codec]
				}
				return formatted.join(' - ')
			}
		},
		template
	})
	// attach element
	const shadowHost = $el('div')
	const shadow = shadowHost.attachShadow ? shadowHost.attachShadow({
		mode: 'closed'
	}) : shadowHost // no shadow dom
	logger.log('shadowHost: %o', shadowHost)
	const container = $el('div')
	shadow.appendChild(container)
	app.$mount(container)
	if (DEBUG && typeof unsafeWindow !== 'undefined') {
		// expose some functions for debugging
		unsafeWindow.$app = app
		unsafeWindow.parseQuery = parseQuery
		unsafeWindow.parseDecsig = parseDecsig
		unsafeWindow.parseResponse = parseResponse
	}
	const load = async playerResponse => {
		try {
			const basejs = (typeof ytplayer !== 'undefined' && 'config' in ytplayer && ytplayer.config.assets ? 'https://' + location.host + ytplayer.config.assets.js : 'web_player_context_config' in ytplayer ? 'https://' + location.host + ytplayer.web_player_context_config.jsUrl : null) || $('script[src$="base.js"]').src
			const decsig = await xf.get(basejs).text(parseDecsig)
			const id = parseQuery(location.search).v
			const data = parseResponse(id, playerResponse, decsig)
			logger.log('video loaded: %s', id)
			app.isLiveStream = data.playerResponse.playabilityStatus.liveStreamability != null
			app.id = id
			app.stream = data.stream
			app.video = data.adaptive.filter(x => x.mimeType.includes('video'));
			app.highvideo = app.video.filter(x => (parseInt(x.qualityLabel) > 720 || parseInt(x.fps) > 30));
			app.lowvideo = app.video.filter(x => parseInt(x.qualityLabel) <= 720 && parseInt(x.fps) <= 30);
			app.audio = data.adaptive.filter(x => x.mimeType.includes('audio'));
			app.details = data.details
		}
		catch (err) {
			alert(app.strings.get_video_failed)
			logger.error('load', err)
		}
	}
	// hook fetch response
	const ff = fetch
	unsafeWindow.fetch = (...args) => {
		if (args[0] instanceof Request) {
			return ff(...args).then(resp => {
				if (resp.url.includes('player')) {
					resp.clone().json().then(load)
				}
				return resp
			})
		}
		return ff(...args)
	}
	// attach element
	setInterval(() => {
		const el = $('#info-contents') || $('#watch-header') || $('.page-container:not([hidden]) ytm-item-section-renderer>lazy-list')
		if (el && !el.contains(shadowHost)) {
			el.appendChild(shadowHost)
		}
	}, 100)
	// init
	unsafeWindow.addEventListener('load', () => {
		const firstResp = unsafeWindow?.ytplayer?.config?.args?.raw_player_response
		if (firstResp) {
			load(firstResp)
		}
	})
	// listen to dark mode toggle
	const $html = $('html')
	new MutationObserver(() => {
		app.dark = $html.getAttribute('dark') !== null
	}).observe($html, {
		attributes: true
	})
	app.dark = $html.getAttribute('dark') !== null
	const css = `
.hide{
	display: none;
}
.t-center{
	text-align: center;
}
.d-flex{
	display: flex;
}
.f-1{
	flex: 1;
}
.fs-14px{
	font-size: 14px;
}
.of-h{
	overflow: hidden;
}
.box{
  padding-top: .5em;
  padding-bottom: .5em;
	border-bottom: 1px solid var(--yt-border-color);
	font-family: Arial;
}
.box-toggle{
	margin: 3px;
	user-select: none;
	-moz-user-select: -moz-none;
}
.ytdl-link-btn{
	display: block;
	border: 1px solid !important;
	border-radius: 3px;
	text-decoration: none !important;
	outline: 0;
	padding: 2px;
	margin: 5px;
	color: black;
}
a, .div-a{
	text-decoration: none;
	color: var(--yt-button-color, inherit);
}
a:hover, .div-a:hover{
	color: var(--yt-spec-call-to-action, blue);
}
.box.dark{
	color: var(--yt-endpoint-color, var(--yt-spec-text-primary));
}
.box.dark .ytdl-link-btn{
	color: var(--yt-spec-call-to-action);
}
.box.dark .ytdl-link-btn:hover{
	color: rgba(200, 200, 255, 0.8);
}
.box.dark .box-toggle:hover{
	color: rgba(200, 200, 255, 0.8);
}
.c-pointer{
	cursor: pointer;
}
.lh-20{
	line-height: 20px;
}
`
	shadow.appendChild($el('style', {
		textContent: css
	}))
	const css2 = `
#meta-contents, #info-contents{
	display: contents !important;
}

ytd-watch-metadata.style-scope {
	display: none !important;
}
`
	document.body.appendChild($el('style', {
		textContent: css2
	}))
})()
