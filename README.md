# Marinar iOS Test

[Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine)를 iPhone과 iPad에서 실행하기 위한 **비공식 iOS 시제품**입니다. 원본의 채팅 화면과 서버를 앱 안에 넣고, 사용자가 설정한 원격 AI API에 연결합니다.

> [첫 시험판 IPA 다운로드](https://github.com/p16481012/Marinar-ios-test/releases/tag/ios-v2.5.1-prototype.1) · [자동 빌드 결과](https://github.com/p16481012/Marinar-ios-test/actions/workflows/ios-prototype.yml)
>
> 아래 기능과 백업 안내는 **현재 `main` 소스 기준**입니다. 공개된 `prototype.1` IPA에는 이후 추가한 iOS 전체 백업·복원과 파일 전송 보완이 포함되어 있지 않습니다.
>
> 채팅·저장·재실행 복원은 모의 API와 iOS 시뮬레이터로 확인했습니다. 파일 선택 후 앱에서 내용을 읽는 흐름과 실기기·실제 API 제공자 검증은 아직 완료하지 않았습니다.

## 현재 소스의 기능

- 기기 안에서 Marinara 서버와 웹 화면 실행
- 원격 API 연결 설정, 대화 생성, 스트리밍 응답과 생성 중지
- 대화 저장과 앱 종료·재실행 후 복원
- 파일 앱 → 이 iPhone/iPad → Marinar iOS Test → `Marinar`에 대화 자료 저장
- 앱이 백그라운드로 이동할 때 저장 요청
- 캐릭터 카드·로어북·프리셋·대화 가져오기와 내보내기
- iOS 공유 화면을 통한 파일 저장, iOS 전체 백업과 재실행 시 복원

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

앱을 삭제하면 앱 안의 자료도 삭제될 수 있습니다. 중요한 자료는 아래 전체 백업으로 앱 밖에 보관하세요.

## 자료 가져오기와 백업

캐릭터 카드·로어북·프리셋·대화는 각 화면의 **Import / Export**에서 옮길 수 있습니다. 파일을 내보내면 iOS 공유 화면에서 **파일에 저장**을 선택합니다. PNG 캐릭터 카드는 카드 정보와 원본 이미지를 함께 보관합니다.

**Settings → Advanced → Backup & Export**에서는 두 종류의 백업을 사용할 수 있습니다.

| 방식 | 용도 |
| --- | --- |
| 기존 프로필 내보내기·가져오기 | 다른 Marinara 환경과 자료를 옮길 때 사용합니다. 기존 자료에 병합하며, 새 환경에서는 API 키를 다시 입력해야 합니다. 같은 설치에 해당 연결의 키가 이미 저장되어 있으면 기존 키를 보존합니다. |
| iOS 전체 백업 | 현재 앱의 데이터·첨부 자료·저장된 API 키를 함께 보관합니다. 복원하면 앱의 현재 자료를 백업 내용으로 교체합니다. |

기존 프로필을 가져오려면 **Settings → Imports → Profile & Marinara → Import Profile (JSON/ZIP)**을 사용합니다.

### iOS 전체 백업 만들기

1. 응답 생성과 자료 변경이 끝난 뒤 **Create full iOS backup**을 누릅니다.
2. 준비가 끝나면 **Save backup to Files**를 누르고, 공유 화면에서 앱 밖의 폴더나 iCloud Drive에 저장합니다.
3. 이 파일에는 API 키를 복구하는 데 필요한 정보도 들어 있습니다. **전체 백업 ZIP 자체에는 비밀번호 암호화가 적용되지 않으므로 타인에게 공유하지 마세요.**

### 전체 백업 복원하기

1. 필요하면 현재 자료를 먼저 백업합니다.
2. **Restore full iOS backup**에서 이 앱이 만든 전체 백업 ZIP을 선택하고 교체 내용을 확인합니다.
3. 파일 검사가 완료되면 앱 전환 화면에서 앱을 완전히 종료한 뒤 다시 엽니다. 복원 대기 중에는 자료 변경이 잠시 제한됩니다. 종료하기 전에는 **Cancel restore and keep current data**로 취소할 수 있습니다.
4. 다음 실행에서 복원합니다. 적용 도중 중단되면 다음 실행 때 이전 자료로 되돌리는 절차를 수행합니다.

일반 프로필 ZIP이나 직접 압축한 데이터 폴더는 전체 백업으로 받지 않습니다. 전체 백업은 최대 1 GiB, 개별 자료 파일은 256 MiB, 개별 저장 테이블 JSON은 32 MiB, ZIP 항목은 20,000개까지 지원합니다. 전송하지 않은 입력 초안과 화면에만 남아 있는 임시 상태는 백업 대상에 포함하지 않습니다. 중요한 백업은 삭제하지 않고 별도로 보관하세요.

파일 앱의 `Marinar` 폴더만 수동 복사하는 방식은 위 전체 백업과 다릅니다. API 키는 암호화해 저장하며, 기본 암호화 키 파일은 `Marinar/.encryption-key`에 있습니다. 숨김 파일 누락이나 키 설정 차이로 복구되지 않을 수 있으므로 전체 백업 기능을 권장합니다.

## 현재 지원 범위의 제한

이번 시험판은 **원격 API 채팅과 자료 보관**에 집중합니다. 원본의 모든 기능을 iOS에서 지원하는 것은 아닙니다.

- 로컬 AI 모델, Python/별도 실행 파일이 필요한 음성·이미지 기능
- 네이티브 이미지 변환·배경 제거, PDF 지식 문서의 로컬 텍스트 추출(일반 이미지 표시·PNG 캐릭터 카드와는 별도)
- 다운로드한 서버 확장, 셸 명령·스크립트 실행, CLI 구독 연결
- 스프라이트 조회·관리, 자율 대화, 다운로드형 기능 패키지
- 자체 서버 업데이트·재시작, 멀티플레이

이 기능들은 지원 범위에서 제외합니다. 앱 업데이트는 새 앱 빌드를 설치하는 방식입니다. 백그라운드에서 계속 AI 응답을 생성하는 동작은 보장하지 않으며, 응답 생성 도중 강제 종료한 부분까지 저장된다고 가정해서는 안 됩니다.

## 빌드와 자동 검사

```sh
# 위 빌드 준비 후, 실제 패키지 서버의 스트리밍·중지·저장·재실행 복원 검사
node scripts/ios/run-chat-lifecycle.mjs --entry ios-app/Resources/runtime/bootstrap.cjs

# OpenAI·Claude·Gemini 형식, 저장된 연결 키와 대화 이력 검사
node scripts/ios/run-provider-lifecycle.mjs --entry ios-app/Resources/runtime/bootstrap.cjs

# 자료 이전, 전체 백업, 복원 취소·손상·중단 후 복구 검사
node scripts/ios/run-transfer-lifecycle.mjs --entry ios-app/Resources/runtime/bootstrap.cjs

# Chrome 설치 환경: 실제 백업 화면·복원 취소·설정 저장 재시도 검사
node scripts/ios/run-backup-ui.mjs --browser-channel chrome

# Apple Silicon Mac: 내장 Node와 WKWebView를 실제 iOS 시뮬레이터에서 검사
node ios-app/scripts/validate-simulator.mjs --simulator-ui --profile all
```

화면 검사를 실행할 때는 Simulator의 **I/O → Keyboard → Connect Hardware Keyboard**를 끄고 소프트웨어 키보드가 표시되도록 설정하세요.

검사는 localhost의 모의 API를 사용합니다. 실제 API 키나 유료 호출이 필요하지 않습니다. 호스트 서버 검사, 시뮬레이터 검사, 실기기 검증은 서로 구분하며, 검사 결과와 화면은 Actions 산출물에 보관합니다.

첫 시험판은 [호스트 검사 13개와 iPhone 16 Pro / iOS 26.2 시뮬레이터 검사 16개](https://github.com/p16481012/Marinar-ios-test/actions/runs/39565137773)를 통과했습니다. 실제 앱 화면에서 메시지를 입력하고 전송한 뒤, 앱 프로세스를 종료·재실행하여 메시지와 응답이 복원되는 과정도 포함합니다.

현재 소스의 검사 결과는 다음과 같습니다. 아래의 개별 검사 성공이 전체 빌드 검증 완료를 뜻하지는 않습니다.

| 검사 | 결과 |
| --- | --- |
| 패키지 서버와 웹 화면 | [66개 통과](https://github.com/p16481012/Marinar-ios-test/actions/runs/39618057694). 원격 API 형식, 자료 이전, 전체 백업의 손상·취소·중단 복구와 백업 화면 조작 포함 |
| 내장 Node와 iPhone 시뮬레이터 | [23개 통과](https://github.com/p16481012/Marinar-ios-test/actions/runs/39618057694). 실제 화면의 메시지 입력·전송, 앱 종료·재실행 복원, 전체 백업의 재실행 적용과 화면 캐시 정리 포함 |
| 작은 iPhone·iPad 화면 | [세로·가로 방향 검사 통과](https://github.com/p16481012/Marinar-ios-test/actions/runs/39618057694). 실제 소프트웨어 키보드 위에서 입력창과 전송 버튼 사용 가능 |
| iPhone용 Release 앱 | [ARM64 컴파일과 런타임 무결성 검사 통과](https://github.com/p16481012/Marinar-ios-test/actions/runs/39616601497). 설치·실행 검증과는 별도 |
| iOS 파일 선택 → 내용 읽기 | 검증 미완료. 전체 시뮬레이터 검사가 통과하기 전까지 새 IPA 배포 보류 |
| 실기기와 실제 API 제공자 | 미검증 |

전체 백업의 재실행 적용 검사는 서버 API로 복원 파일을 전달한 뒤 수행했습니다. iOS 파일 선택부터 복원까지의 전체 조작은 아직 검증하지 못했습니다.

## 원본과 라이선스

- 기반: Marinara Engine **2.5.1**, [`8042ef6`](https://github.com/Pasta-Devs/Marinara-Engine/commit/8042ef6ec638801de45b8d82f82cd2dea85f51a4)
- iOS 런타임: [fogtape/nodejs-mobile 24.22.0-0](https://github.com/fogtape/nodejs-mobile/releases/tag/v24.22.0-0), full 프리릴리스 빌드를 SHA-256으로 고정
- 라이선스: [AGPL-3.0](LICENSE). 원본 저작권과 각 의존성의 라이선스를 유지합니다.

이 저장소는 원본 Marinara 팀의 공식 iOS 배포판이 아닙니다. 원본 사용 설명은 `docs/`에, iOS 앱과 빌드 도구는 `ios-app/`에 있습니다.
