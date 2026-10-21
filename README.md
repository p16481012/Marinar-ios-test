# Marinar iOS Test

[Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine)를 iPhone과 iPad에서 실행하기 위한 **비공식 iOS 시제품**입니다. 원본의 채팅 화면과 서버를 앱 안에 넣고, 사용자가 설정한 원격 AI API에 연결합니다.

> [첫 시험판 IPA 다운로드](https://github.com/p16481012/Marinar-ios-test/releases/tag/ios-v2.5.1-prototype.1) · [자동 빌드 결과](https://github.com/p16481012/Marinar-ios-test/actions/workflows/ios-prototype.yml)
>
> 모의 API를 이용한 채팅·저장·재실행 복원을 iOS 시뮬레이터에서 확인한 시험판입니다. 실기기와 실제 API 제공자에 대한 검증은 아직 완료하지 않았습니다.

## 첫 시제품의 범위

- 기기 안에서 Marinara 서버와 웹 화면 실행
- 원격 API 연결 설정, 대화 생성, 스트리밍 응답과 생성 중지
- 대화 저장과 앱 종료·재실행 후 복원
- 파일 앱 → 이 iPhone/iPad → Marinar iOS Test → `Marinar`에 대화 자료 저장
- 앱이 백그라운드로 이동할 때 저장 요청

외부 PC에 Marinara 서버를 켜둘 필요는 없습니다. **원격 AI 응답에는 인터넷 또는 설정한 AI 서버에 대한 네트워크 연결이 필요합니다.** 이 앱 자체에 AI 모델이 들어 있지는 않습니다.

## 설치

| 환경 | 설치 경로 |
| --- | --- |
| Mac | 아래 순서로 직접 빌드하고 Xcode에서 Apple ID로 서명하여 설치 |
| Windows | [시험판 배포 페이지](https://github.com/p16481012/Marinar-ios-test/releases/tag/ios-v2.5.1-prototype.1)의 Assets에서 `unsigned.ipa` 파일을 받은 뒤, Sideloadly·AltStore 등으로 직접 서명하여 설치 |

IPA는 서명되지 않은 파일입니다. 파일을 iPhone에 복사하는 것만으로 설치되지는 않습니다. 사이드로드 도구의 기기 연결·서명 요건을 따라야 합니다. [Sideloadly](https://sideloadly.io/), [AltStore 설치 안내](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows)를 참고하세요.

### Mac에서 직접 빌드

Apple Silicon Mac, Xcode 16 이상, Node.js 24, Corepack이 필요합니다. 빌드 대상은 iOS/iPadOS 16.4 이상입니다. 화면에 사용하는 [Tailwind의 Safari 요구 버전](https://tailwindcss.com/docs/compatibility)에 맞춘 최소 조건이며, 해당 버전 실기기의 동작 검증이 완료되었다는 뜻은 아닙니다. 현재 포함하는 Node 프레임워크의 시뮬레이터 아키텍처는 ARM64입니다.

```sh
git clone https://github.com/p16481012/Marinar-ios-test.git
cd Marinar-ios-test
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm --filter @marinara-engine/shared build
SKIP_PWA=1 corepack pnpm --filter @marinara-engine/client build
node ios-app/scripts/prepare.mjs
node ios-app/scripts/download-node.mjs
open ios-app/Marinar.xcodeproj
```

Xcode에서 `Marinar` 타깃의 **Signing & Capabilities → Team**에 본인의 Apple ID 팀을 선택합니다. 필요하면 Bundle Identifier를 고유한 값으로 바꾸고, 연결한 iPhone/iPad를 선택해 실행합니다. 무료 계정의 서명 기간과 설치 제한은 Apple 정책을 따릅니다.

### 처음 실행한 뒤

1. 앱이 로컬 서버와 화면을 준비할 때까지 기다립니다.
2. **Connections(체인 아이콘) → +(New)**에서 이름과 **Provider**를 선택하고 **Create**를 누릅니다. 아이콘이 안 보이면 상단 **더보기(⋯)** 메뉴에서 Connections를 엽니다.
3. **API Key**를 입력하고 **Model**을 선택한 뒤 상단 **Save(디스켓 아이콘)**를 누릅니다. 모델 목록이 비어 있으면 **Fetch Models from API**로 불러옵니다. 공식 제공자의 **Base URL**은 기본값을 사용하고, 커스텀 연결은 해당 서비스의 API 주소를 입력합니다.
4. 홈에서 **Roleplay**를 선택하고 **Connection**에 저장한 연결을 지정합니다. 나머지는 기본값으로 **Next → Start**를 눌러 시작한 뒤 메시지를 보냅니다. 캐릭터는 나중에 추가해도 됩니다.
5. 응답이 끝난 뒤 홈 화면으로 이동하고 앱을 다시 열어 대화가 남아 있는지 확인합니다.

연결 오류는 **Connection Tests → Test Connection**에서 확인할 수 있습니다. 캐릭터와 대화하려면 **Characters → New/Import**로 카드를 준비해 대화에 추가하세요. **Conversation** 모드는 캐릭터를 한 명 이상 선택해야 시작됩니다.

앱을 삭제하면 앱 안의 자료도 삭제될 수 있습니다. 중요한 대화는 원본 Marinara의 내보내기 기능으로 별도 보관하세요. 파일 앱의 데이터 폴더만 복사한 자료는 완전한 복구본이 아닙니다. 연결 키 암호화에 쓰이는 설정은 앱의 비공개 저장소에 있습니다.

## 현재 지원 범위의 제한

이번 단계는 **원격 API 채팅과 저장·복원**에 집중합니다. 원본 화면에 표시되는 모든 메뉴를 iOS에서 지원하는 것은 아닙니다.

- 로컬 AI 모델, Python/별도 실행 파일이 필요한 음성·이미지 기능
- 네이티브 이미지 처리와 PDF 문서 처리
- 다운로드한 서버 확장, 셸 명령·스크립트 실행, CLI 구독 연결
- 자체 서버 업데이트·재시작, 멀티플레이

이 기능들은 첫 시제품에서 제외합니다. 앱 업데이트는 새 앱 빌드를 설치하는 방식입니다. 백그라운드에서 계속 AI 응답을 생성하는 동작은 보장하지 않으며, 응답 생성 도중 강제 종료한 부분까지 저장된다고 가정해서는 안 됩니다.

## 빌드와 자동 검사

```sh
# 위 빌드 준비 후, 실제 패키지 서버의 스트리밍·중지·저장·재실행 복원 검사
node scripts/ios/run-chat-lifecycle.mjs --entry ios-app/Resources/runtime/bootstrap.cjs

# Apple Silicon Mac: 내장 Node와 WKWebView를 실제 iOS 시뮬레이터에서 검사
node ios-app/scripts/validate-simulator.mjs
```

검사는 localhost의 모의 OpenAI 호환 API를 사용합니다. 실제 API 키나 유료 호출이 필요하지 않습니다. 호스트 서버 검사, 시뮬레이터 검사, 실기기 검증은 서로 구분하며, 검사 결과와 화면은 Actions 산출물에 보관합니다.

첫 시험판은 [호스트 검사 13개와 iPhone 16 Pro / iOS 26.2 시뮬레이터 검사 16개](https://github.com/p16481012/Marinar-ios-test/actions/runs/39565137773)를 통과했습니다. 실제 앱 화면에서 메시지를 입력하고 전송한 뒤, 앱 프로세스를 종료·재실행하여 메시지와 응답이 복원되는 과정도 포함합니다. 다른 iOS 버전과 iPad 화면은 별도 검증이 필요합니다.

## 원본과 라이선스

- 기반: Marinara Engine **2.5.1**, [`8042ef6`](https://github.com/Pasta-Devs/Marinara-Engine/commit/8042ef6ec638801de45b8d82f82cd2dea85f51a4)
- iOS 런타임: [fogtape/nodejs-mobile 24.22.0-0](https://github.com/fogtape/nodejs-mobile/releases/tag/v24.22.0-0), full 프리릴리스 빌드를 SHA-256으로 고정
- 라이선스: [AGPL-3.0](LICENSE). 원본 저작권과 각 의존성의 라이선스를 유지합니다.

이 저장소는 원본 Marinara 팀의 공식 iOS 배포판이 아닙니다. 원본 사용 설명은 `docs/`에, iOS 앱과 빌드 도구는 `ios-app/`에 있습니다.
