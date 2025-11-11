document.addEventListener('DOMContentLoaded', () => {
    const API_BASE_URL = 'https://aisns-sk05.onrender.com'; 
	

	
	const input = document.getElementById('input');
	const sendButton = document.getElementById('send');
	
	const resultContainer = document.getElementById('result-container'); 
	const resultContent = document.getElementById('result-content');
		const resultTextDiv = document.getElementById('result-text');
		const resultImageDiv = document.getElementById('result-image');
		const archiveButton = document.getElementById('archiveButton');
		const statusMessage = document.getElementById('statusMessage'); 
		const archivesDiv = document.getElementById('archives');
	
		let currentResult = {};

		function buildApiUrl(endpoint) {
			const base = API_BASE_URL.endsWith('/') ? API_BASE_URL : API_BASE_URL + '/';
			const path = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;

			return `${base}api/${path}`;
		}
		
		fetchArchives();
	
		sendButton.addEventListener('click', async () => {
			const userText = input.value.trim();
			if (!userText) {
				alert('テキストを入力してください');
				return;
			}
	
			resultContent.classList.add('hidden');
			archiveButton.classList.add('hidden');
			resultContainer.classList.add('justify-center');
			statusMessage.textContent = 'Step 1/3: AIが言葉を変換中...';
			statusMessage.classList.remove('hidden');
	
			currentResult = { originalText: userText };
	
			try {
				const res = await fetch(buildApiUrl('transform'), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ text: userText })
				});
	
				const data = await res.json();
				
				if (data.error) {
					statusMessage.textContent = `変換エラー: ${data.error}`;
					return;
				}
	
				const { friendlyText, imagePrompt } = data;
				
				currentResult.friendlyText = friendlyText;
				currentResult.imagePrompt = imagePrompt;
	
				statusMessage.textContent = 'Step 2/3: DALL-E 3が画像を生成中 (約20秒)...';
				
				//画像生成
				const imgRes = await fetch(buildApiUrl('generate-image'), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ imagePrompt: imagePrompt }) 
				});
				
				const imgData = await imgRes.json();
	
				if (imgData.error) {
					statusMessage.textContent = `画像生成エラー: ${imgData.error}`;
					return;
				}
				
				const base64Image = imgData.image;
				currentResult.base64Image = base64Image;
	
				statusMessage.classList.add('hidden');
				resultContainer.classList.remove('justify-center');
				resultContent.classList.remove('hidden');
	
				resultTextDiv.innerHTML = `
					<p class="text-gray-500 text-sm font-medium">✨ ソムリエの一言</p>
					<p class="text-3xl font-extrabold text-gray-900">${friendlyText}</p>
					<p class="text-xs text-gray-400 mt-2">（生成プロンプトは非表示に設定されています）</p>
				`;
	
				resultImageDiv.innerHTML = `
					<img src="data:image/jpeg;base64,${base64Image}" alt="生成画像" class="w-full h-auto rounded-xl shadow-2xl border-4 border-indigo-200" />
				`;
				
				archiveButton.disabled = false;
				archiveButton.textContent = '✅ アーカイブに保存';
				archiveButton.classList.remove('hidden');
	
	
			} catch (err) {
				console.error('致命的なエラーが発生しました:', err);
				statusMessage.textContent = `🚨 致命的エラー: ${err.message}`;
				statusMessage.classList.remove('hidden');
				resultContent.classList.add('hidden');
			} finally {
			}
		});
	
		archiveButton.addEventListener('click', async () => {
			if (!currentResult.base64Image) {
				alert('画像データが見つかりません。');
				return;
			}
	
			archiveButton.disabled = true;
			archiveButton.textContent = '🌐 保存中...';
	
			try {
				const archivePayload = {
					originalText: currentResult.originalText,
					friendlyText: currentResult.friendlyText,
					imagePrompt: currentResult.imagePrompt,
					base64Image: currentResult.base64Image 
				};
				
				const res = await fetch(buildApiUrl('archive'), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(archivePayload)
				});
	
				const data = await res.json();
	
				if (data.error) throw new Error(data.error);
	
				archiveButton.textContent = '✅ 保存済み！';
				archiveButton.disabled = true;
				archiveButton.classList.add('hidden');
				
				fetchArchives();
	
			} catch (error) {
				console.error('アーカイブ失敗:', error);
				archiveButton.textContent = `🚨 エラー`;
				alert(`アーカイブ保存エラー: ${error.message}`);
			} finally {
				archiveButton.disabled = false;
			}
		});
		
		async function fetchArchives() {
			archivesDiv.innerHTML = '<p class="text-center text-gray-500">...アーカイブを読み込み中...</p>'; 
	
			try {
				const res = await fetch(buildApiUrl('archives'));
				const archives = await res.json();
	
				if (archives.error) {
					archivesDiv.innerHTML = `<p class="text-red-500 font-bold">アーカイブエラー: ${archives.error}</p>`;
					return;
				}
	
				if (archives.length === 0) {
					archivesDiv.innerHTML = '<p class="text-center text-gray-500">まだ作品がありません。</p>';
					return;
				}
	
				archivesDiv.innerHTML = archives.map(archive => {
					const timestampSeconds = archive.timestamp && archive.timestamp._seconds;
					const date = timestampSeconds ? new Date(timestampSeconds * 1000).toLocaleString('ja-JP') : '日付不明';
	
					const imageSource = archive.imageUrl 
										? archive.imageUrl 
										: (archive.base64Image ? `data:image/jpeg;base64,${archive.base64Image}` : '');
					
					const imageContent = imageSource 
						? `<img src="${imageSource}" alt="作品画像" class="w-full h-auto rounded" />`
						: `<div class="w-full h-24 bg-gray-200 rounded flex items-center justify-center text-gray-500 text-xs">画像なし</div>`;
	
					return `
						<div class="p-4 border rounded-lg shadow-sm mb-4 bg-white">
							<div class="flex items-start">
								<div class="w-1/3 mr-4">
									${imageContent}
								</div>
								<div class="w-2/3">
									<p class="text-xs text-gray-500 mb-1">${date}</p>
									<p class="text-lg font-semibold text-indigo-700 mb-2">${archive.friendlyText}</p>
									<p class="text-sm text-gray-700 italic">元文: ${archive.originalText}</p>
									<p class="text-xs text-gray-400 mt-2 break-all">プロンプト: ${archive.imagePrompt.substring(0, 50)}...</p>
									${archive.imageUrl ? 
										`<p class="text-xs text-green-700 break-all mt-1">
											<span class="font-semibold">URL:</span> 
											<a href="${archive.imageUrl}" target="_blank" class="underline hover:text-green-500">${archive.imageUrl.substring(0, 40)}...</a>
										</p>` 
										: ''}
								</div>
							</div>
						</div>
					`;
				}).join('');
	
			} catch (e) {
				console.error('アーカイブ取得中にエラー:', e);
				archivesDiv.innerHTML = `<p class="text-red-500 font-bold">アーカイブの読み込み中に致命的なエラーが発生しました。</p><p class="text-sm text-red-400">詳細: ${e.message}</p>`;
			}
		}
	});